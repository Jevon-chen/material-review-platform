const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'review.db');

if (!fs.existsSync(DB_FILE)) {
  console.log('No database file found');
  process.exit(1);
}

const db = new Database(DB_FILE);

// New agents data
const newAgents = [
  { name: '北岸传奇', brands: ['山海', '捷途', '纵横'], username: '北岸传奇', password: '123456' },
  { name: '北京智阅', brands: ['捷途', '山海', '纵横'], username: '北京智阅', password: '123456' },
  { name: '桃羽文化', brands: ['捷途', '山海', '纵横'], username: '桃羽文化', password: '123456' }
];

const tx = db.transaction(() => {
  // Delete old agents
  const oldAgents = db.prepare("SELECT * FROM users WHERE role = 'agent'").all();
  oldAgents.forEach(a => {
    // Delete their materials
    db.prepare('DELETE FROM materials WHERE agent = ?').run(a.agent_name);
    // Delete their targets
    db.prepare('DELETE FROM targets WHERE agent = ?').run(a.agent_name);
    // Delete their config
    db.prepare('DELETE FROM config WHERE key = ?').run('agent_' + a.agent_name);
    // Delete user
    db.prepare('DELETE FROM users WHERE id = ?').run(a.id);
  });
  console.log('Deleted old agents:', oldAgents.map(a => a.agent_name).join(', '));

  // Insert new agents
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, name, role, agent_name, can_review, can_view_all, can_settings) VALUES (?, ?, ?, ?, ?, 0, 0, 0)');
  const setConfig = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  
  newAgents.forEach(a => {
    const hash = bcrypt.hashSync(a.password, 10);
    insertUser.run(a.username, hash, a.name, 'agent', a.name);
    const configVal = JSON.stringify({
      brands: a.brands,
      contact: '',
      phone: '',
      monthTarget: 0,
      deadline: '',
      rhythm: ''
    });
    setConfig.run('agent_' + a.name, configVal);
    console.log('Added agent:', a.name, '| brands:', a.brands.join(','));
  });

  // Reset nextMaterialId
  setConfig.run('nextMaterialId', '1');
});

tx();
console.log('Migration complete!');

db.close();
