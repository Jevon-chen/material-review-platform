# 素材预审台 - 云部署指南

## 方案一：Render.com 免费部署（推荐，5分钟搞定）

### 前置条件
- GitHub 账号
- Render 账号（可用 GitHub 登录）

### 步骤

#### 1. 上传代码到 GitHub
```bash
cd 素材预审台-server
git init
git add .
git commit -m "素材预审台 v2 - 代理级联更新版"
git remote add origin https://github.com/你的用户名/素材预审台-server.git
git push -u origin main
```

#### 2. 在 Render 创建服务
1. 打开 https://dashboard.render.com
2. 点击 "New" → "Web Service"
3. 连接你的 GitHub 仓库
4. 配置：
   - **Name**: jetour-material-review
   - **Runtime**: Node
   - **Build Command**: npm install
   - **Start Command**: node server.js
   - **Plan**: Free
5. 添加环境变量：
   - `JWT_SECRET` = 随便一个长字符串（用于Token加密）
6. 点击 "Create Web Service"

#### 3. 等待部署完成
- 首次部署约2-3分钟
- 部署完成后会获得一个 URL，如：`https://jetour-material-review.onrender.com`

### ⚠️ 免费版限制
- **15分钟无访问会休眠**，首次唤醒需30秒
- **SQLite数据不持久**（重启后恢复种子数据）— 适合演示
- 如需数据持久化，升级 Starter 计划 $7/月，添加 Persistent Disk

---

## 方案二：Render + 持久磁盘（生产环境推荐）

在 Render Starter 计划 ($7/月) 基础上：
1. 添加 Persistent Disk（1GB，免费额度内）
2. 挂载路径设为 `/opt/render/project/data`
3. 修改 server.js 中的数据目录：
   ```
   var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
   var UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
   ```
4. 设置环境变量：
   - `DATA_DIR` = `/opt/render/project/data`
   - `UPLOAD_DIR` = `/opt/render/project/uploads`

---

## 方案三：自有服务器部署

### Docker 部署（最简单）
```bash
# 构建镜像
docker build -t jetour-review .

# 运行容器
docker run -d \
  --name jetour-review \
  -p 3000:3000 \
  -v ./data:/app/data \
  -v ./uploads:/app/uploads \
  -e JWT_SECRET=你的密钥 \
  jetour-review
```

### 直接运行
```bash
cd 素材预审台-server
npm install
node server.js
```

---

## 账号信息

| 角色 | 用户名 | 密码 | 权限 |
|------|--------|------|------|
| 品牌方 | brand | 123456 | 全量数据+审核+系统设置 |
| 代理 | 注册时自定义 | 自定义 | 仅看本代理素材+提交 |

首次启动自动初始化3个演示代理（明锐互动/光合作用/新视野）。

---

## 代理配置级联更新说明（v2新增）

修改代理配置时，所有关联数据自动同步更新：
- **改代理名** → 素材、目标、操作日志、配置键名全部同步
- **改关联品牌** → 自动增删对应目标记录
- **删代理** → 素材、目标、配置、上传文件全部清理
