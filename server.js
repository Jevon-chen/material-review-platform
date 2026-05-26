var express = require('express');
var http = require('http');
var path = require('path');
var fs = require('fs');
var bcrypt = require('bcryptjs');
var jwt = require('jsonwebtoken');
var multer = require('multer');
var WebSocket = require('ws');
var Database = require('better-sqlite3');
var dbSync = require('./db-sync');

var app = express();
var server = http.createServer(app);
var PORT = process.env.PORT || 3000;
var JWT_SECRET = process.env.JWT_SECRET || 'jtr_review_secret_2026';

// ===== Database Setup =====
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
var UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

var db = new Database(path.join(DATA_DIR, 'review.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== Create Tables =====
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  agent_name TEXT,
  can_review INTEGER DEFAULT 0,
  can_view_all INTEGER DEFAULT 0,
  can_settings INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#00A2AE',
  keywords TEXT DEFAULT '', desc TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vehicle_models (
  id TEXT PRIMARY KEY, brand TEXT NOT NULL, name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, vehicle_model_id TEXT NOT NULL, name TEXT NOT NULL,
  desc TEXT DEFAULT '', expression_rule TEXT DEFAULT '', apply_types TEXT DEFAULT '',
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, brand TEXT NOT NULL, type TEXT NOT NULL,
  agent TEXT NOT NULL, month TEXT NOT NULL, status TEXT DEFAULT 'pending',
  score INTEGER, ai_result TEXT, created_at TEXT NOT NULL,
  review_note TEXT DEFAULT '', reject_reason TEXT DEFAULT '',
  resubmit_count INTEGER DEFAULT 0, duration TEXT, file_size TEXT,
  premium INTEGER DEFAULT 0, model TEXT, platform TEXT, policy TEXT,
  version INTEGER DEFAULT 1, file_path TEXT
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, brand TEXT NOT NULL, month TEXT NOT NULL,
  video_count INTEGER DEFAULT 0, submitted INTEGER DEFAULT 0,
  approved INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL,
  user TEXT NOT NULL, action TEXT NOT NULL, target TEXT DEFAULT '', detail TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sensitive_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, word TEXT NOT NULL,
  UNIQUE(category, word)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`);

// ===== Multer Setup =====
var storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) {
    var ext = path.extname(file.originalname);
    var base = path.basename(file.originalname, ext);
    cb(null, Date.now() + '-' + base + ext);
  }
});
var upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ===== Middleware =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  var header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  var token = header.substring(7);
  try {
    var decoded = jwt.verify(token, JWT_SECRET);
    var user = db.prepare('SELECT * FROM users WHERE username = ?').get(decoded.username);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token无效' });
  }
}

// ===== WebSocket Setup =====
var wss = new WebSocket.Server({ server: server, path: '/ws' });
var wsClients = [];

wss.on('connection', function (ws, req) {
  var params = new URL(req.url, 'http://localhost').searchParams;
  var token = params.get('token');
  if (!token) { ws.close(); return; }
  try {
    var decoded = jwt.verify(token, JWT_SECRET);
    ws._username = decoded.username;
    wsClients.push(ws);
    ws.on('close', function () {
      wsClients = wsClients.filter(function (c) { return c !== ws; });
    });
  } catch (e) {
    ws.close();
  }
});

function broadcastWS(type, data) {
  var msg = JSON.stringify({ type: type, data: data });
  wsClients.forEach(function (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// ===== Helper Functions =====
function getCurrentMonth() {
  var now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function addAuditLog(user, action, target, detail) {
  var now = new Date();
  var ds = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  db.prepare('INSERT INTO audit_log (time, user, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(ds, user, action, target || '', detail || '');
}

function getConfigObj(key) {
  var row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setConfigObj(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

function generateToken(username) {
  return jwt.sign({ username: username }, JWT_SECRET, { expiresIn: '7d' });
}

function filterMaterialsForUser(user) {
  if (user.can_view_all) return '1=1';
  return 'agent = ?';
}

function filterMaterialsParamsForUser(user) {
  if (user.can_view_all) return [];
  return [user.agent_name];
}

// ===== Auth Routes =====
// Mark DB as dirty on all write operations
app.use(function(req, res, next) {
  if (['POST', 'PUT', 'DELETE'].indexOf(req.method) >= 0 && req.path.startsWith('/api/') && req.path !== '/api/auth/login') {
    var originalEnd = res.end;
    res.end = function() {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        dbSync.markDirty();
      }
      originalEnd.apply(res, arguments);
    };
  }
  next();
});

app.post('/api/auth/login', function (req, res) {
  var username = req.body.username;
  var password = req.body.password;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  var user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: '用户名不存在' });
  var valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: '密码错误' });
  var token = generateToken(username);
  var userData = { id: user.id, username: user.username, name: user.name, role: user.role, agent_name: user.agent_name, can_review: user.can_review, can_view_all: user.can_view_all, can_settings: user.can_settings };
  res.json({ token: token, user: userData });
});

app.get('/api/auth/me', authMiddleware, function (req, res) {
  var user = req.user;
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role, agent_name: user.agent_name, can_review: user.can_review, can_view_all: user.can_view_all, can_settings: user.can_settings });
});

// ===== Dashboard =====
app.get('/api/dashboard', authMiddleware, function (req, res) {
  var user = req.user;
  var baseFilter = filterMaterialsForUser(user);
  var baseParams = filterMaterialsParamsForUser(user);

  var pending = db.prepare('SELECT COUNT(*) as c FROM materials WHERE status = ? AND ' + baseFilter).get('pending', ...baseParams).c;
  var aiReviewed = db.prepare('SELECT COUNT(*) as c FROM materials WHERE status = ? AND ' + baseFilter).get('ai_reviewed', ...baseParams).c;
  var approved = db.prepare('SELECT COUNT(*) as c FROM materials WHERE status = ? AND ' + baseFilter).get('approved', ...baseParams).c;
  var rejected = db.prepare('SELECT COUNT(*) as c FROM materials WHERE status = ? AND ' + baseFilter).get('rejected', ...baseParams).c;

  var total = pending + aiReviewed + approved + rejected;
  var avgScoreRow = db.prepare('SELECT AVG(score) as avg FROM materials WHERE score IS NOT NULL AND ' + baseFilter).get(...baseParams);
  var avgScore = avgScoreRow && avgScoreRow.avg ? Math.round(avgScoreRow.avg) : 0;
  var passRate = total ? Math.round(approved / total * 100) : 0;
  var premiumCount = db.prepare('SELECT COUNT(*) as c FROM materials WHERE premium = 1 AND ' + baseFilter).get(...baseParams).c;

  var recentMaterials = db.prepare('SELECT * FROM materials WHERE ' + baseFilter + ' ORDER BY created_at DESC LIMIT 4').all(...baseParams).map(function (m) {
    if (m.ai_result) m.ai_result = JSON.parse(m.ai_result);
    m.premium = !!m.premium;
    return m;
  });

  var agentDeadlines = [];
  if (user.can_view_all) {
    var agents = db.prepare('SELECT * FROM users WHERE role = ?').all('agent');
    agents.forEach(function (a) {
      if (a.agent_name) {
        var agentRow = db.prepare('SELECT * FROM config WHERE key = ?').get('agent_' + a.agent_name);
        if (agentRow) {
          var aData = JSON.parse(agentRow.value);
          agentDeadlines.push({ name: a.agent_name, deadline: aData.deadline });
        }
      }
    });
  }

  res.json({ pending: pending, aiReviewed: aiReviewed, approved: approved, rejected: rejected, avgScore: avgScore, passRate: passRate, premiumCount: premiumCount, recentMaterials: recentMaterials, agentDeadlines: agentDeadlines });
});

// ===== Materials =====
app.get('/api/materials', authMiddleware, function (req, res) {
  var user = req.user;
  var conditions = [filterMaterialsForUser(user)];
  var params = filterMaterialsParamsForUser(user);

  if (req.query.brand) { conditions.push('brand = ?'); params.push(req.query.brand); }
  if (req.query.model) { conditions.push('model = ?'); params.push(req.query.model); }
  if (req.query.platform) { conditions.push('platform = ?'); params.push(req.query.platform); }
  if (req.query.status) { conditions.push('status = ?'); params.push(req.query.status); }
  if (req.query.search) { conditions.push('(title LIKE ? OR agent LIKE ?)'); params.push('%' + req.query.search + '%', '%' + req.query.search + '%'); }
  if (req.query.month) { conditions.push('month = ?'); params.push(req.query.month); }

  var where = conditions.join(' AND ');
  var rows = db.prepare('SELECT * FROM materials WHERE ' + where + ' ORDER BY created_at DESC').all(...params);
  rows.forEach(function (m) {
    if (m.ai_result) m.ai_result = JSON.parse(m.ai_result);
    m.premium = !!m.premium;
  });
  res.json(rows);
});

app.post('/api/materials', authMiddleware, upload.array('files', 20), function (req, res) {
  var user = req.user;
  var title = req.body.title;
  var brand = req.body.brand;
  var type = req.body.type;
  var month = req.body.month || getCurrentMonth();
  var model = req.body.model || '';
  var platform = req.body.platform || '';
  var policy = req.body.policy || '';
  var agent = user.role === 'brand' ? (req.body.agent || user.name) : user.agent_name;

  if (!title) return res.status(400).json({ error: '请填写标题' });
  if (!brand) return res.status(400).json({ error: '请选择品牌' });

  var files = req.files || [];
  var now = new Date();
  var ds = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

  var nextIdRow = db.prepare("SELECT value FROM config WHERE key = 'nextMaterialId'").get();
  var nextId = nextIdRow ? parseInt(nextIdRow.value) : 9;

  var created = [];
  var insertStmt = db.prepare('INSERT INTO materials (id, title, brand, type, agent, month, status, score, ai_result, created_at, review_note, reject_reason, resubmit_count, duration, file_size, premium, model, platform, policy, version, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  var doInsert = db.transaction(function () {
    for (var i = 0; i < Math.max(files.length, 1); i++) {
      var matId = 'M' + String(nextId).padStart(3, '0');
      var matTitle = files.length <= 1 ? title : title + ' (' + (i + 1) + ')';
      var fileSize = files[i] ? (files[i].size > 1048576 ? (files[i].size / 1048576).toFixed(0) + 'MB' : (files[i].size / 1024).toFixed(0) + 'KB') : '-';
      var duration = files[i] && files[i].mimetype && files[i].mimetype.startsWith('video/') ? (Math.floor(Math.random() * 5 + 1) + ':' + String(Math.floor(Math.random() * 59)).padStart(2, '0')) : '-';
      var filePath = files[i] ? files[i].filename : null;

      insertStmt.run(matId, matTitle, brand, type, agent, month, 'pending', null, null, ds, '', '', 0, duration, fileSize, 0, model, platform, policy, 1, filePath);
      created.push(matId);

      // Update target
      var target = db.prepare('SELECT * FROM targets WHERE agent = ? AND brand = ? AND month = ?').get(agent, brand, month);
      if (target) {
        db.prepare('UPDATE targets SET submitted = submitted + 1 WHERE id = ?').run(target.id);
      }

      addAuditLog(user.name, 'submit', matTitle, '提交素材，车型:' + (model || '未选') + '，平台:' + platform);
      nextId++;
    }
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('nextMaterialId', ?)").run(String(nextId));
  });

  doInsert();

  // Broadcast
  created.forEach(function (id) {
    broadcastWS('material_created', { id: id });
  });

  res.json({ created: created });
});

app.get('/api/materials/:id', authMiddleware, function (req, res) {
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  if (!req.user.can_view_all && m.agent !== req.user.agent_name) return res.status(403).json({ error: '无权查看' });
  if (m.ai_result) m.ai_result = JSON.parse(m.ai_result);
  m.premium = !!m.premium;
  res.json(m);
});

app.put('/api/materials/:id', authMiddleware, function (req, res) {
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  var fields = [];
  var params = [];
  var allowedFields = ['title', 'brand', 'type', 'model', 'platform', 'policy', 'month'];
  allowedFields.forEach(function (f) {
    if (req.body[f] !== undefined) { fields.push(f + ' = ?'); params.push(req.body[f]); }
  });
  if (fields.length === 0) return res.json({ updated: 0 });
  params.push(req.params.id);
  db.prepare('UPDATE materials SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  broadcastWS('material_updated', { id: req.params.id });
  res.json({ updated: 1 });
});

app.post('/api/materials/:id/review', authMiddleware, function (req, res) {
  var user = req.user;
  if (!user.can_review) return res.status(403).json({ error: '无审核权限' });
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });

  var standards = getConfigObj('standards');
  var flow = getConfigObj('flow');
  if (!standards || !flow) return res.status(500).json({ error: '审核标准未配置' });

  var dims = standards.dimensions;
  var aiResult = {};
  var totalW = 0;
  dims.forEach(function (d) { totalW += d.weight; });
  if (!totalW) totalW = 100;
  var score = 0;
  dims.forEach(function (dim) {
    var s = 50 + Math.floor(Math.random() * 48);
    aiResult[dim.id] = s;
    score += s * dim.weight / totalW;
  });
  score = Math.round(score);

  var newStatus;
  var reviewNote = '';
  var rejectReason = '';
  if (flow.autoRejectBelow > 0 && score < flow.autoRejectBelow) {
    newStatus = 'rejected';
    reviewNote = 'AI自动驳回';
    rejectReason = 'AI评分 ' + score + ' 低于自动驳回线 ' + flow.autoRejectBelow;
  } else if (!flow.humanConfirm) {
    newStatus = score >= standards.overallPassScore ? 'approved' : 'rejected';
    reviewNote = score >= standards.overallPassScore ? 'AI审核通过' : 'AI审核未通过';
  } else {
    newStatus = 'ai_reviewed';
  }

  db.prepare('UPDATE materials SET score = ?, ai_result = ?, status = ?, review_note = ?, reject_reason = ? WHERE id = ?').run(score, JSON.stringify(aiResult), newStatus, reviewNote, rejectReason, m.id);

  if (newStatus === 'approved') updateTargetOnAction(m.agent, m.brand, m.month, 'approved');
  if (newStatus === 'rejected') updateTargetOnAction(m.agent, m.brand, m.month, 'rejected');

  addAuditLog(user.name, 'review', m.title, 'AI审核，评分:' + score);
  broadcastWS('material_updated', { id: m.id, status: newStatus, score: score });
  res.json({ reviewed: 1, score: score, status: newStatus });
});

app.post('/api/materials/:id/approve', authMiddleware, function (req, res) {
  var user = req.user;
  if (!user.can_review) return res.status(403).json({ error: '无审核权限' });
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  db.prepare('UPDATE materials SET status = ?, review_note = ? WHERE id = ?').run('approved', '通过', m.id);
  updateTargetOnAction(m.agent, m.brand, m.month, 'approved');
  addAuditLog(user.name, 'approve', m.title, '审核通过，评分:' + (m.score || '-'));
  broadcastWS('material_updated', { id: m.id, status: 'approved' });
  res.json({ approved: 1 });
});

app.post('/api/materials/:id/reject', authMiddleware, function (req, res) {
  var user = req.user;
  if (!user.can_review) return res.status(403).json({ error: '无审核权限' });
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  var reason = req.body.reason || '';
  db.prepare('UPDATE materials SET status = ?, review_note = ?, reject_reason = ? WHERE id = ?').run('rejected', '驳回', reason, m.id);
  updateTargetOnAction(m.agent, m.brand, m.month, 'rejected');
  addAuditLog(user.name, 'reject', m.title, reason);
  broadcastWS('material_updated', { id: m.id, status: 'rejected' });
  res.json({ rejected: 1 });
});

app.post('/api/materials/:id/premium', authMiddleware, function (req, res) {
  var user = req.user;
  if (!user.can_review) return res.status(403).json({ error: '无审核权限' });
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  var newPremium = m.premium ? 0 : 1;
  db.prepare('UPDATE materials SET premium = ? WHERE id = ?').run(newPremium, m.id);
  addAuditLog(user.name, 'premium', m.title, newPremium ? '标注优质' : '取消优质');
  broadcastWS('material_updated', { id: m.id, premium: !!newPremium });
  res.json({ toggled: 1, premium: !!newPremium });
});

app.post('/api/materials/batch-review', authMiddleware, function (req, res) {
  var user = req.user;
  if (!user.can_review) return res.status(403).json({ error: '无审核权限' });
  var pending = db.prepare('SELECT * FROM materials WHERE status = ?').all('pending');
  var results = [];
  var standards = getConfigObj('standards');
  var flow = getConfigObj('flow');
  if (!standards || !flow) return res.status(500).json({ error: '审核标准未配置' });

  var doBatch = db.transaction(function () {
    pending.forEach(function (m) {
      var dims = standards.dimensions;
      var aiResult = {};
      var totalW = 0;
      dims.forEach(function (d) { totalW += d.weight; });
      if (!totalW) totalW = 100;
      var score = 0;
      dims.forEach(function (dim) {
        var s = 50 + Math.floor(Math.random() * 48);
        aiResult[dim.id] = s;
        score += s * dim.weight / totalW;
      });
      score = Math.round(score);

      var newStatus;
      var reviewNote = '';
      var rejectReason = '';
      if (flow.autoRejectBelow > 0 && score < flow.autoRejectBelow) {
        newStatus = 'rejected';
        reviewNote = 'AI自动驳回';
        rejectReason = 'AI评分 ' + score + ' 低于自动驳回线 ' + flow.autoRejectBelow;
      } else if (!flow.humanConfirm) {
        newStatus = score >= standards.overallPassScore ? 'approved' : 'rejected';
        reviewNote = score >= standards.overallPassScore ? 'AI审核通过' : 'AI审核未通过';
      } else {
        newStatus = 'ai_reviewed';
      }

      db.prepare('UPDATE materials SET score = ?, ai_result = ?, status = ?, review_note = ?, reject_reason = ? WHERE id = ?').run(score, JSON.stringify(aiResult), newStatus, reviewNote, rejectReason, m.id);
      if (newStatus === 'approved') updateTargetOnAction(m.agent, m.brand, m.month, 'approved');
      if (newStatus === 'rejected') updateTargetOnAction(m.agent, m.brand, m.month, 'rejected');
      addAuditLog(user.name, 'review', m.title, 'AI审核，评分:' + score);
      results.push({ id: m.id, score: score, status: newStatus });
      broadcastWS('material_updated', { id: m.id, status: newStatus, score: score });
    });
  });

  doBatch();
  res.json({ results: results });
});

app.get('/api/materials/:id/file', authMiddleware, function (req, res) {
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  if (!m.file_path) return res.status(404).json({ error: '无文件' });
  var filePath = path.join(UPLOAD_DIR, m.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(filePath);
});

function updateTargetOnAction(agent, brand, month, action) {
  var t = db.prepare('SELECT * FROM targets WHERE agent = ? AND brand = ? AND month = ?').get(agent, brand, month);
  if (t) {
    if (action === 'approved') db.prepare('UPDATE targets SET approved = MIN(submitted, approved + 1) WHERE id = ?').run(t.id);
    if (action === 'rejected') db.prepare('UPDATE targets SET rejected = MIN(submitted, rejected + 1) WHERE id = ?').run(t.id);
  }
}

// ===== Brands =====
app.get('/api/brands', authMiddleware, function (req, res) {
  res.json(db.prepare('SELECT * FROM brands').all());
});

app.post('/api/brands', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var id = 'b_' + Date.now();
  db.prepare('INSERT INTO brands (id, name, color, keywords, desc) VALUES (?, ?, ?, ?, ?)').run(id, req.body.name, req.body.color || '#00A2AE', req.body.keywords || '', req.body.desc || '');
  res.json({ created: 1, id: id });
});

app.put('/api/brands/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var fields = [];
  var params = [];
  ['name', 'color', 'keywords', 'desc'].forEach(function (f) {
    if (req.body[f] !== undefined) { fields.push(f + ' = ?'); params.push(req.body[f]); }
  });
  if (fields.length === 0) return res.json({ updated: 0 });
  params.push(req.params.id);
  db.prepare('UPDATE brands SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ updated: 1 });
});

// ===== Vehicle Models =====
app.get('/api/vehicle-models', authMiddleware, function (req, res) {
  var rows;
  if (req.query.brand) {
    rows = db.prepare('SELECT * FROM vehicle_models WHERE brand = ?').all(req.query.brand);
  } else {
    rows = db.prepare('SELECT * FROM vehicle_models').all();
  }
  // Attach policies
  rows.forEach(function (vm) {
    vm.policies = db.prepare('SELECT * FROM policies WHERE vehicle_model_id = ?').all(vm.id);
  });
  res.json(rows);
});

app.post('/api/vehicle-models', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var id = 'vm_' + Date.now();
  db.prepare('INSERT INTO vehicle_models (id, brand, name) VALUES (?, ?, ?)').run(id, req.body.brand, req.body.name);
  res.json({ created: 1, id: id });
});

app.put('/api/vehicle-models/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var fields = [];
  var params = [];
  ['brand', 'name'].forEach(function (f) {
    if (req.body[f] !== undefined) { fields.push(f + ' = ?'); params.push(req.body[f]); }
  });
  if (fields.length === 0) return res.json({ updated: 0 });
  params.push(req.params.id);
  db.prepare('UPDATE vehicle_models SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ updated: 1 });
});

app.delete('/api/vehicle-models/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  db.prepare('DELETE FROM policies WHERE vehicle_model_id = ?').run(req.params.id);
  db.prepare('DELETE FROM vehicle_models WHERE id = ?').run(req.params.id);
  res.json({ deleted: 1 });
});

// ===== Policies =====
app.get('/api/policies', authMiddleware, function (req, res) {
  if (req.query.vehicleModelId) {
    res.json(db.prepare('SELECT * FROM policies WHERE vehicle_model_id = ?').all(req.query.vehicleModelId));
  } else {
    res.json(db.prepare('SELECT * FROM policies').all());
  }
});

app.post('/api/policies', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var id = 'p_' + Date.now();
  db.prepare('INSERT INTO policies (id, vehicle_model_id, name, desc, expression_rule, apply_types, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.body.vehicle_model_id, req.body.name, req.body.desc || '', req.body.expression_rule || '', req.body.apply_types || '', req.body.status || 'active');
  res.json({ created: 1, id: id });
});

app.put('/api/policies/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var fields = [];
  var params = [];
  ['vehicle_model_id', 'name', 'desc', 'expression_rule', 'apply_types', 'status'].forEach(function (f) {
    if (req.body[f] !== undefined) { fields.push(f + ' = ?'); params.push(req.body[f]); }
  });
  if (fields.length === 0) return res.json({ updated: 0 });
  params.push(req.params.id);
  db.prepare('UPDATE policies SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ updated: 1 });
});

app.delete('/api/policies/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  db.prepare('DELETE FROM policies WHERE id = ?').run(req.params.id);
  res.json({ deleted: 1 });
});

app.post('/api/policies/:id/toggle', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var p = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '政策不存在' });
  var newStatus = p.status === 'active' ? 'inactive' : 'active';
  db.prepare('UPDATE policies SET status = ? WHERE id = ?').run(newStatus, req.params.id);
  res.json({ toggled: 1, status: newStatus });
});

// ===== Sensitive Words =====
app.get('/api/sensitive-words', authMiddleware, function (req, res) {
  var rows = db.prepare('SELECT * FROM sensitive_words').all();
  var categories = {
    extreme: { name: '极限词', words: [] },
    misleading: { name: '误导词', words: [] },
    edge: { name: '擦边词', words: [] },
    forbidden: { name: '禁用词', words: [] },
    platform: { name: '平台违规', words: [] }
  };
  rows.forEach(function (r) {
    if (categories[r.category]) {
      categories[r.category].words.push({ id: r.id, word: r.word });
    }
  });
  res.json({ categories: categories });
});

app.post('/api/sensitive-words', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  try {
    db.prepare('INSERT INTO sensitive_words (category, word) VALUES (?, ?)').run(req.body.category, req.body.word);
    res.json({ added: 1 });
  } catch (e) {
    if (e.message.indexOf('UNIQUE') >= 0) return res.status(400).json({ error: '该词已存在' });
    throw e;
  }
});

app.delete('/api/sensitive-words/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  db.prepare('DELETE FROM sensitive_words WHERE id = ?').run(req.params.id);
  res.json({ deleted: 1 });
});

// ===== Standards =====
app.get('/api/standards', authMiddleware, function (req, res) {
  var standards = getConfigObj('standards');
  res.json(standards || {});
});

app.put('/api/standards', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  setConfigObj('standards', req.body);
  res.json({ updated: 1 });
});

// ===== Flow =====
app.get('/api/flow', authMiddleware, function (req, res) {
  var flow = getConfigObj('flow');
  res.json(flow || {});
});

app.put('/api/flow', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  setConfigObj('flow', req.body);
  res.json({ updated: 1 });
});

// ===== Agents =====
app.get('/api/agents', authMiddleware, function (req, res) {
  var rows = db.prepare('SELECT * FROM users WHERE role = ?').all('agent');
  var agents = rows.map(function (u) {
    var agentConfig = getConfigObj('agent_' + u.agent_name);
    return {
      id: u.id,
      name: u.agent_name,
      brands: agentConfig ? agentConfig.brands : [],
      contact: agentConfig ? agentConfig.contact : '',
      phone: agentConfig ? agentConfig.phone : '',
      monthTarget: agentConfig ? agentConfig.monthTarget : 10,
      username: u.username,
      deadline: agentConfig ? agentConfig.deadline : '',
      rhythm: agentConfig ? agentConfig.rhythm : ''
    };
  });
  res.json(agents);
});

app.post('/api/agents', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var name = req.body.name;
  var username = req.body.username;
  var password = req.body.password;
  if (!name || !username || !password) return res.status(400).json({ error: '缺少必填项' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  var existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: '登录名已存在' });

  var hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, name, role, agent_name, can_review, can_view_all, can_settings) VALUES (?, ?, ?, ?, ?, 0, 0, 0)').run(username, hash, name, 'agent', name);

  setConfigObj('agent_' + name, {
    brands: req.body.brands || [],
    contact: req.body.contact || '',
    phone: req.body.phone || '',
    monthTarget: req.body.monthTarget || 10,
    deadline: req.body.deadline || '',
    rhythm: req.body.rhythm || ''
  });

  res.json({ created: 1 });
});

app.put('/api/agents/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '代理不存在' });

  var oldAgentName = user.agent_name;
  var newName = req.body.name && req.body.name !== user.agent_name ? req.body.name : null;

  // Check username uniqueness
  if (req.body.username && req.body.username !== user.username) {
    var existing = db.prepare('SELECT * FROM users WHERE username = ? AND id != ?').get(req.body.username, req.params.id);
    if (existing) return res.status(400).json({ error: '登录名已占用' });
  }

  // Load existing config
  var existingConfig = getConfigObj('agent_' + oldAgentName) || {};
  var newBrands = req.body.brands || existingConfig.brands || [];
  var finalAgentName = newName || oldAgentName;

  // === All updates in one transaction for consistency ===
  var doUpdate = db.transaction(function () {
    // 1. Update user table
    if (req.body.username && req.body.username !== user.username) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(req.body.username, req.params.id);
    }
    if (req.body.password && req.body.password.length >= 6) {
      var hash = bcrypt.hashSync(req.body.password, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
    }
    if (newName) {
      db.prepare('UPDATE users SET name = ?, agent_name = ? WHERE id = ?').run(newName, newName, req.params.id);
    }

    // 2. Cascade: agent name change → update ALL related tables
    if (newName && newName !== oldAgentName) {
      // materials.agent
      db.prepare('UPDATE materials SET agent = ? WHERE agent = ?').run(newName, oldAgentName);
      // targets.agent
      db.prepare('UPDATE targets SET agent = ? WHERE agent = ?').run(newName, oldAgentName);
      // audit_log.user (stores agent name as user field for agent actions)
      db.prepare('UPDATE audit_log SET user = ? WHERE user = ?').run(newName, oldAgentName);
      // Migrate config key
      var oldConfigRow = db.prepare('SELECT * FROM config WHERE key = ?').get('agent_' + oldAgentName);
      if (oldConfigRow) {
        db.prepare('DELETE FROM config WHERE key = ?').run('agent_' + oldAgentName);
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('agent_' + newName, oldConfigRow.value);
      }
    }

    // 3. Cascade: brands change → update targets
    var oldBrands = existingConfig.brands || [];
    var brandsChanged = JSON.stringify(newBrands.sort()) !== JSON.stringify(oldBrands.sort());

    if (brandsChanged) {
      var curMonth = getCurrentMonth();
      // Remove targets for brands no longer associated
      oldBrands.forEach(function (b) {
        if (newBrands.indexOf(b) === -1) {
          db.prepare('DELETE FROM targets WHERE agent = ? AND brand = ?').run(finalAgentName, b);
        }
      });
      // Auto-create targets for newly added brands (current month only)
      newBrands.forEach(function (b) {
        if (oldBrands.indexOf(b) === -1) {
          var exists = db.prepare('SELECT * FROM targets WHERE agent = ? AND brand = ? AND month = ?').get(finalAgentName, b, curMonth);
          if (!exists) {
            var tid = 'T_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
            var monthTarget = req.body.monthTarget || existingConfig.monthTarget || 10;
            db.prepare('INSERT INTO targets (id, agent, brand, month, video_count, submitted, approved, rejected) VALUES (?, ?, ?, ?, ?, 0, 0, 0)').run(tid, finalAgentName, b, curMonth, monthTarget);
          }
        }
      });
    }

    // 4. Update config
    var newConfig = {
      brands: newBrands,
      contact: req.body.contact || existingConfig.contact || '',
      phone: req.body.phone || existingConfig.phone || '',
      monthTarget: req.body.monthTarget || existingConfig.monthTarget || 10,
      deadline: req.body.deadline || existingConfig.deadline || '',
      rhythm: req.body.rhythm || existingConfig.rhythm || ''
    };
    setConfigObj('agent_' + finalAgentName, newConfig);
  });

  doUpdate();

  // Audit log
  var changes = [];
  if (newName) changes.push('名称: ' + oldAgentName + '→' + newName);
  if (req.body.brands) changes.push('品牌: ' + JSON.stringify(req.body.brands));
  addAuditLog(req.user.name, 'update_agent', '修改代理', (changes.length ? changes.join('; ') : '更新配置'));

  broadcastWS('agent_updated', { id: req.params.id, oldName: oldAgentName, newName: finalAgentName });
  res.json({ updated: 1, cascaded: { nameChanged: !!newName, oldName: oldAgentName, newName: finalAgentName } });
});

app.delete('/api/agents/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '代理不存在' });

  var agentName = user.agent_name;
  var matCount = db.prepare('SELECT COUNT(*) as c FROM materials WHERE agent = ?').get(agentName).c;
  var targetCount = db.prepare('SELECT COUNT(*) as c FROM targets WHERE agent = ?').get(agentName).c;

  var doDelete = db.transaction(function () {
    // 1. Delete agent's materials (and their uploaded files)
    var mats = db.prepare('SELECT file_path FROM materials WHERE agent = ?').all(agentName);
    mats.forEach(function (m) {
      if (m.file_path) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, m.file_path)); } catch (e) { /* ignore */ }
      }
    });
    db.prepare('DELETE FROM materials WHERE agent = ?').run(agentName);
    // 2. Delete agent's targets
    db.prepare('DELETE FROM targets WHERE agent = ?').run(agentName);
    // 3. Delete agent config
    db.prepare('DELETE FROM config WHERE key = ?').run('agent_' + agentName);
    // 4. Delete user
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  });

  doDelete();

  addAuditLog(req.user.name, 'delete_agent', '删除代理', '删除代理: ' + agentName + ' (含' + matCount + '条素材, ' + targetCount + '条目标)');
  broadcastWS('agent_deleted', { id: req.params.id, name: agentName });
  res.json({ deleted: 1, cascaded: { materials: matCount, targets: targetCount } });
});

// ===== Targets =====
app.get('/api/targets', authMiddleware, function (req, res) {
  var user = req.user;
  var month = req.query.month || getCurrentMonth();
  var rows;
  if (user.can_view_all) {
    rows = db.prepare('SELECT * FROM targets WHERE month = ?').all(month);
  } else {
    rows = db.prepare('SELECT * FROM targets WHERE agent = ? AND month = ?').all(user.agent_name, month);
  }
  res.json(rows);
});

app.post('/api/targets', authMiddleware, function (req, res) {
  if (!req.user.can_settings && !req.user.can_view_all) return res.status(403).json({ error: '无权限' });
  var id = 'T_' + Date.now();
  db.prepare('INSERT INTO targets (id, agent, brand, month, video_count, submitted, approved, rejected) VALUES (?, ?, ?, ?, ?, 0, 0, 0)').run(id, req.body.agent, req.body.brand, req.body.month || getCurrentMonth(), req.body.videoCount || 10);
  res.json({ created: 1, id: id });
});

app.put('/api/targets/:id', authMiddleware, function (req, res) {
  if (!req.user.can_settings && !req.user.can_view_all) return res.status(403).json({ error: '无权限' });
  var fields = [];
  var params = [];
  ['video_count', 'submitted', 'approved', 'rejected'].forEach(function (f) {
    if (req.body[f] !== undefined) { fields.push(f + ' = ?'); params.push(req.body[f]); }
  });
  if (fields.length === 0) return res.json({ updated: 0 });
  params.push(req.params.id);
  db.prepare('UPDATE targets SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ updated: 1 });
});

// ===== Audit Log =====
app.get('/api/audit-log', authMiddleware, function (req, res) {
  if (!req.user.can_settings) return res.status(403).json({ error: '无权限' });
  var conditions = [];
  var params = [];
  if (req.query.action) { conditions.push('action = ?'); params.push(req.query.action); }
  if (req.query.user) { conditions.push('user = ?'); params.push(req.query.user); }
  var where = conditions.length ? conditions.join(' AND ') : '1=1';
  var rows = db.prepare('SELECT * FROM audit_log WHERE ' + where + ' ORDER BY id DESC LIMIT 500').all(...params);
  res.json(rows);
});

// ===== Monthly Clear =====
app.post('/api/monthly-clear', authMiddleware, function (req, res) {
  if (!req.user.can_view_all) return res.status(403).json({ error: '无权限' });
  var curMonth = getCurrentMonth();
  var before = db.prepare('SELECT COUNT(*) as c FROM materials').get().c;
  db.prepare('DELETE FROM materials WHERE month < ?').run(curMonth);
  var after = db.prepare('SELECT COUNT(*) as c FROM materials').get().c;
  var cleared = before - after;
  setConfigObj('lastClearMonth', curMonth);
  addAuditLog(req.user.name, 'clear', '月度清空', '清除 ' + cleared + ' 条历史素材');
  broadcastWS('monthly_cleared', { cleared: cleared });
  res.json({ cleared: cleared });
});

// ===== Clear All Materials (Admin) =====
app.post('/api/materials/clear-all', authMiddleware, function (req, res) {
  if (!req.user.can_view_all) return res.status(403).json({ error: '无权限' });
  var before = db.prepare('SELECT COUNT(*) as c FROM materials').get().c;
  // Delete uploaded files
  var materials = db.prepare('SELECT file_path FROM materials WHERE file_path IS NOT NULL').all();
  materials.forEach(function (m) {
    try {
      var fp = path.join(UPLOAD_DIR, m.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) { /* ignore */ }
  });
  db.prepare('DELETE FROM materials').run();
  addAuditLog(req.user.name, 'clear', '清空所有素材', '清除 ' + before + ' 条素材及文件');
  broadcastWS('monthly_cleared', { cleared: before });
  res.json({ cleared: before });
});

// ===== Delete Single Material =====
app.delete('/api/materials/:id', authMiddleware, function (req, res) {
  var m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '素材不存在' });
  if (!req.user.can_view_all && m.agent !== req.user.name) return res.status(403).json({ error: '无权限' });
  // Delete uploaded file
  if (m.file_path) {
    try {
      var fp = path.join(UPLOAD_DIR, m.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) { /* ignore */ }
  }
  db.prepare('DELETE FROM materials WHERE id = ?').run(req.params.id);
  addAuditLog(req.user.name, 'delete', m.title, '删除素材');
  broadcastWS('material_updated', { id: req.params.id, deleted: true });
  res.json({ deleted: 1 });
});

// ===== Seed Data =====
function seedData() {
  var brandCount = db.prepare('SELECT COUNT(*) as c FROM brands').get().c;
  if (brandCount > 0) return;

  console.log('Initializing seed data...');

  // Brand account
  var brandHash = bcrypt.hashSync('123456', 10);
  db.prepare('INSERT INTO users (username, password_hash, name, role, agent_name, can_review, can_view_all, can_settings) VALUES (?, ?, ?, ?, ?, 1, 1, 1)').run('brand', brandHash, '品牌方', 'brand', null);

  // Brands
  var insertBrand = db.prepare('INSERT INTO brands (id, name, color, keywords, desc) VALUES (?, ?, ?, ?, ?)');
  insertBrand.run('jt', '捷途', '#00A2AE', '旅行+、硬派越野、家庭出行、国民SUV', '捷途品牌线，主打旅行+生态与国民SUV');
  insertBrand.run('sh', '山海', '#8b5cf6', '高端新能源、智能座舱、旗舰品质、山海系列', '山海品牌线，高端新能源旗舰系列');
  insertBrand.run('zh', '纵横', '#f59e0b', '硬核越野、极限挑战、专业级、纵横系列', '纵横品牌线，专业硬核越野系列');

  // Vehicle Models
  var insertVM = db.prepare('INSERT INTO vehicle_models (id, brand, name) VALUES (?, ?, ?)');
  var vmData = [
    ['vm_1', '捷途', '自由者'], ['vm_2', '捷途', 'X70PLUS'], ['vm_3', '捷途', 'X70L'],
    ['vm_4', '捷途', '旅行者'], ['vm_5', '捷途', '大圣'], ['vm_6', '捷途', 'X90'],
    ['vm_7', '山海', '山海T1'], ['vm_8', '山海', '旅行者C-DM'], ['vm_9', '山海', '旅行者PLUS C-DM'],
    ['vm_10', '山海', '山海L7'], ['vm_11', '山海', '山海L7PLUS'], ['vm_12', '纵横', '纵横G700']
  ];
  var insertVMMany = db.transaction(function () { vmData.forEach(function (d) { insertVM.run(d[0], d[1], d[2]); }); });
  insertVMMany();

  // Policies
  var insertPolicy = db.prepare('INSERT INTO policies (id, vehicle_model_id, name, desc, expression_rule, apply_types, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  var policyData = [
    ['p_1', 'vm_1', '33000元优惠', '20000(超级置换金)+13000(国补)+包牌包税包保险', '置换价/至高补:厂家补贴+国补;口播:严禁旧车残值+厂补置换', '口播,证言,沉浸式', 'active'],
    ['p_2', 'vm_1', '置换优惠+免息', '置换厂补+免息', '', '口播,证言', 'active'],
    ['p_3', 'vm_2', '0首付', '0首付方案', '仅25款X70PLUS冠军版可用0首付', '口播', 'active'],
    ['p_4', 'vm_2', '43000元优惠', '20000(厂补)+10000(超级置换)+13000(国补)', '', '口播,证言,沉浸式', 'active'],
    ['p_5', 'vm_2', '41000元优惠', '20000(厂补)+8000(超级置换)+13000(国补)', '', '口播,证言,沉浸式', 'active'],
    ['p_6', 'vm_2', '首付999分60期', '首付999元,60期分期', '这台999那台999(捷途允许)', '口播', 'active'],
    ['p_7', 'vm_2', '置换优惠+免息', '置换优惠+免息方案', '', '口播,证言', 'active'],
    ['p_8', 'vm_3', '至高32000元优惠', '至高9000(超级置换)+13000(国补)+10000(购车基金)', '', '口播,证言,沉浸式', 'active'],
    ['p_9', 'vm_3', '置换优惠+免息', '', '', '口播,证言', 'active'],
    ['p_10', 'vm_3', '低首付+置换优惠', '', '', '口播', 'active'],
    ['p_11', 'vm_4', '至高3.3万优惠(含国补)', '10000(超级置换厂补)+10000(现金厂补)+国补至高1.3万', '', '口播,证言,沉浸式', 'active'],
    ['p_12', 'vm_4', '0首付', '0首付方案', '', '口播', 'active'],
    ['p_13', 'vm_4', '置换优惠+免息', '', '', '口播,证言', 'active'],
    ['p_14', 'vm_4', '一成首付+置换优惠+7年低息', '', '', '口播,证言', 'active'],
    ['p_15', 'vm_5', '0首付', '0首付方案', '仅大圣青春版可用0首付', '口播', 'active'],
    ['p_16', 'vm_5', '3年8万全额免息', '3年8万全额免息', '', '口播,证言', 'active'],
    ['p_17', 'vm_5', '首付888分60期', '', '', '口播', 'active'],
    ['p_18', 'vm_5', '一口价6.99万', '一口价6.99万', '', '口播,证言', 'active'],
    ['p_19', 'vm_5', '免息+0首付', '', '', '口播', 'active'],
    ['p_20', 'vm_6', '综合优惠方案', '详情咨询经销商', '', '口播,证言', 'active'],
    ['p_21', 'vm_7', '首付1100,2年8万免息', '5年贷2年免息,月供低至1667元', '', '口播,证言', 'active'],
    ['p_22', 'vm_7', '至高25000元综合优惠', '国补1.5万+厂补1万', '', '口播,证言,沉浸式', 'active'],
    ['p_23', 'vm_8', '一成首付,3年10万免息', '至高25000元综合优惠(10000厂补+15000国补)', '', '口播,证言', 'active'],
    ['p_24', 'vm_9', '一成首付,3年8万免息', '至高22000元综合优惠(7000厂补+15000国补)', '', '口播,证言', 'active'],
    ['p_25', 'vm_10', '首付1100', '厂补1万+3000旅行红包', '', '口播', 'active'],
    ['p_26', 'vm_10', '至高20000元综合优惠', '国补1万+厂补1万', '', '口播,证言,沉浸式', 'active'],
    ['p_27', 'vm_11', '首付1100,3年8万/12万免息', '', '', '口播,证言', 'active'],
    ['p_28', 'vm_11', '至高25000元综合优惠', '国补1.5万+厂补1万', '', '口播,证言,沉浸式', 'active'],
    ['p_29', 'vm_12', '至高25000(厂补)+报废2万或置换1.5万(国补)', '可叠加,十大权益', '', '口播,证言,沉浸式', 'active'],
    ['p_30', 'vm_12', '5年自由贷,0首付,超低息', '纵享金融礼', '', '口播', 'active']
  ];
  var insertPolicyMany = db.transaction(function () { policyData.forEach(function (d) { insertPolicy.run(d[0], d[1], d[2], d[3], d[4], d[5], d[6]); }); });
  insertPolicyMany();

  // Sensitive Words
  var swData = {
    extreme: ['最高', '最佳', '顶级', '极品', '第一', '首选', '史无前例', '独家', '唯一', '不二之选', '最好', '最很', '引领者', '领导者', '特供'],
    misleading: ['不要钱', '不要一分钱', '贷款毫无压力', '0成本', '库存车', '特价车', '清仓价', '急售', '降价', '原价', '现价', '小成本', '低成本', '特价处理', '长草车', '落灰车'],
    edge: ['旧车抵新车', '多抵2万', '旧车当首付', '新车不加钱', '不怎么要加钱', '旧车直接换新车', '低成本换新车', '月供一点点', '月供压力不大', '少花点钱换新车', '旧车抵车款'],
    forbidden: ['再不抢就没了', '超级置换补贴', '包牌', '战斗机', '坦克', '破车', '烂车', '报废车', '老破车', '开不动', '首付一分钱不花', '首付不花钱开新车', '花呗', '白条', '黑户', '包过户', '不摇号上牌'],
    platform: ['点击头像', '点击下方', '关注我', '私信我', '加微信', '留电话', '二维码', '联系方式', '引导箭头', '手势指向']
  };
  var insertSW = db.prepare('INSERT INTO sensitive_words (category, word) VALUES (?, ?)');
  var insertSWMany = db.transaction(function () {
    for (var cat in swData) {
      swData[cat].forEach(function (w) { insertSW.run(cat, w); });
    }
  });
  insertSWMany();

  // Standards
  var standards = {
    dimensions: [
      { id: 'brand', name: '品牌一致性', weight: 30, passScore: 70, checks: [{ id: 'b1', name: 'Logo规范', desc: '品牌logo露出位置、大小、时长符合品牌手册', enabled: true }, { id: 'b2', name: '品牌色使用', desc: '画面主色调、字幕颜色符合品牌VI规范', enabled: true }, { id: 'b3', name: '品牌调性', desc: '文案风格、叙事方式与品牌调性一致', enabled: true }, { id: 'b4', name: 'Slogan使用', desc: '品牌标语使用正确且完整', enabled: true }, { id: 'b5', name: '车型信息准确', desc: '车型名称、配置参数、售价等信息准确无误', enabled: true }] },
      { id: 'quality', name: '画面质量', weight: 25, passScore: 65, checks: [{ id: 'q1', name: '分辨率达标', desc: '视频分辨率≥1080P', enabled: true }, { id: 'q2', name: '画面稳定', desc: '无异常抖动、跳帧', enabled: true }, { id: 'q3', name: '音频清晰', desc: '人声清晰可辨', enabled: true }, { id: 'q4', name: '字幕规范', desc: '字幕字体、位置规范，无错别字', enabled: true }, { id: 'q5', name: '剪辑节奏', desc: '节奏流畅，转场自然', enabled: true }] },
      { id: 'compliance', name: '合规性', weight: 25, passScore: 80, checks: [{ id: 'c1', name: '广告法合规', desc: '无绝对化用语', enabled: true }, { id: 'c2', name: '极限词排查', desc: '不含"最""第一"等极限词', enabled: true }, { id: 'c3', name: '竞品规避', desc: '不出现竞品品牌/标识', enabled: true }, { id: 'c4', name: '数据真实性', desc: '数据引用有据可查', enabled: true }, { id: 'c5', name: '肖像权/版权', desc: '出镜有授权，素材无版权风险', enabled: true }, { id: 'c6', name: '安全提示', desc: '危险动作有安全提示', enabled: true }] },
      { id: 'creative', name: '创意指数', weight: 20, passScore: 60, checks: [{ id: 'cr1', name: '故事性', desc: '有完整叙事结构', enabled: true }, { id: 'cr2', name: '传播潜力', desc: '具备社交传播性', enabled: true }, { id: 'cr3', name: '互动引导', desc: '引导用户互动', enabled: true }, { id: 'cr4', name: '视觉差异化', desc: '与同类内容有区隔', enabled: true }] }
    ],
    overallPassScore: 70
  };
  setConfigObj('standards', standards);

  // Flow
  var flow = { aiAutoReview: true, humanConfirm: true, allowResubmit: true, resubmitLimit: 3, autoRejectBelow: 40 };
  setConfigObj('flow', flow);

  // Agents
  var agents = [
    { name: '明锐互动', brands: ['捷途'], contact: '张经理', phone: '138****1234', monthTarget: 15, username: 'mingrui', password: '123456', deadline: '2026-05-25', rhythm: '每周5条' },
    { name: '光合作用', brands: ['山海', '捷途'], contact: '李经理', phone: '139****5678', monthTarget: 10, username: 'guanghe', password: '123456', deadline: '2026-05-28', rhythm: '每周3条' },
    { name: '新视野', brands: ['纵横', '山海'], contact: '王经理', phone: '137****9012', monthTarget: 8, username: 'xinshiye', password: '123456', deadline: '2026-05-30', rhythm: '每周2条' }
  ];
  var insertAgent = db.prepare('INSERT INTO users (username, password_hash, name, role, agent_name, can_review, can_view_all, can_settings) VALUES (?, ?, ?, ?, ?, 0, 0, 0)');
  agents.forEach(function (a) {
    var hash = bcrypt.hashSync(a.password, 10);
    insertAgent.run(a.username, hash, a.name, 'agent', a.name);
    setConfigObj('agent_' + a.name, { brands: a.brands, contact: a.contact, phone: a.phone, monthTarget: a.monthTarget, deadline: a.deadline, rhythm: a.rhythm });
  });

  // Sample Materials
  var insertMat = db.prepare('INSERT INTO materials (id, title, brand, type, agent, month, status, score, ai_result, created_at, review_note, reject_reason, resubmit_count, duration, file_size, premium, model, platform, policy, version, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  var matData = [
    ['M001', '捷途旅行者-沙漠穿越篇', '捷途', '短视频', '明锐互动', '2026-05', 'pending', null, null, '2026-05-20', '', '', 0, '1:32', '48MB', 0, '旅行者', '抖音', '至高3.3万优惠(含国补)', 1, null],
    ['M002', '山海T2-露营生活Vlog', '山海', 'Vlog', '光合作用', '2026-05', 'pending', null, null, '2026-05-21', '', '', 0, '3:15', '128MB', 0, '山海T1', '抖音', '至高25000元综合优惠', 1, null],
    ['M003', '纵横F-越野挑战赛', '纵横', '短视频', '新视野', '2026-05', 'pending', null, null, '2026-05-21', '', '', 0, '2:08', '76MB', 0, '纵横G700', '快手', '至高25000(厂补)+报废2万或置换1.5万(国补)', 1, null],
    ['M004', '捷途大圣-城市通勤日常', '捷途', '短视频', '明锐互动', '2026-05', 'approved', 87, JSON.stringify({ brand: 90, quality: 88, compliance: 82, creativity: 86 }), '2026-05-18', '通过', '', 0, '1:15', '42MB', 1, '大圣', '抖音', '0首付', 1, null],
    ['M005', '山海L9-家庭出行记', '山海', '长视频', '光合作用', '2026-05', 'approved', 92, JSON.stringify({ brand: 95, quality: 90, compliance: 94, creativity: 88 }), '2026-05-17', '优质素材', '', 0, '5:30', '220MB', 1, '山海L7', '视频号', '至高20000元综合优惠', 1, null],
    ['M006', '纵横G600-硬核测评', '纵横', '测评', '新视野', '2026-04', 'rejected', 45, JSON.stringify({ brand: 50, quality: 40, compliance: 30, creativity: 55 }), '2026-04-28', '驳回', '品牌露出不合规，logo使用错误；广告法违规：出现"最强越野"极限词；竞品车型画面未做模糊处理', 1, '4:12', '156MB', 0, '纵横G700', '抖音', '至高25000(厂补)+报废2万或置换1.5万(国补)', 2, null],
    ['M007', '捷途X70-五一自驾攻略', '捷途', '攻略', '明锐互动', '2026-05', 'ai_reviewed', 78, JSON.stringify({ brand: 82, quality: 76, compliance: 70, creativity: 80 }), '2026-05-22', '', '', 0, '2:45', '98MB', 0, 'X70PLUS', '抖音', '43000元优惠', 1, null],
    ['M008', '山海V1-潮玩改装', '山海', '短视频', '光合作用', '2026-05', 'ai_reviewed', 83, JSON.stringify({ brand: 85, quality: 80, compliance: 88, creativity: 78 }), '2026-05-22', '', '', 0, '1:58', '65MB', 0, '山海L7PLUS', '全平台', '至高25000元综合优惠', 1, null]
  ];
  var insertMatMany = db.transaction(function () { matData.forEach(function (d) { insertMat.run(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15], d[16], d[17], d[18], d[19], d[20]); }); });
  insertMatMany();

  // Targets
  var insertTarget = db.prepare('INSERT INTO targets (id, agent, brand, month, video_count, submitted, approved, rejected) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  var targetData = [
    ['T001', '明锐互动', '捷途', '2026-05', 15, 8, 5, 1],
    ['T002', '明锐互动', '捷途', '2026-04', 12, 12, 10, 2],
    ['T003', '光合作用', '山海', '2026-05', 10, 6, 4, 1],
    ['T004', '光合作用', '山海', '2026-04', 10, 10, 8, 2],
    ['T005', '新视野', '纵横', '2026-05', 8, 5, 3, 1],
    ['T006', '新视野', '纵横', '2026-04', 8, 8, 6, 2]
  ];
  var insertTargetMany = db.transaction(function () { targetData.forEach(function (d) { insertTarget.run(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]); }); });
  insertTargetMany();

  // Config
  setConfigObj('nextMaterialId', '9');
  setConfigObj('lastClearMonth', getCurrentMonth());

  console.log('Seed data initialized.');
}

// ===== Monthly Auto-Clear =====
function checkMonthlyClear() {
  var curMonth = getCurrentMonth();
  var lastClear = getConfigObj('lastClearMonth');
  if (!lastClear || lastClear < curMonth) {
    var before = db.prepare('SELECT COUNT(*) as c FROM materials').get().c;
    db.prepare('DELETE FROM materials WHERE month < ?').run(curMonth);
    var after = db.prepare('SELECT COUNT(*) as c FROM materials').get().c;
    var cleared = before - after;
    setConfigObj('lastClearMonth', curMonth);
    if (cleared > 0) {
      addAuditLog('系统', 'clear', '月度清空', '自动清除 ' + cleared + ' 条上月素材');
      broadcastWS('monthly_cleared', { cleared: cleared });
      console.log('Monthly auto-clear: removed ' + cleared + ' materials.');
    }
  }
}

// ===== Start Server =====
// Initialize Git persistence before seeding
dbSync.init();

seedData();
checkMonthlyClear();

if (process.argv.indexOf('--init-only') >= 0) {
  console.log('Database initialized. Exiting.');
  process.exit(0);
}

server.listen(PORT, function () {
  console.log('捷途素材预审台 server running on port ' + PORT);
  // Start auto-sync after server is up
  dbSync.startAutoSync();
});
