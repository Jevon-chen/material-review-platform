/**
 * Git Persistence Module for SQLite Database
 * 
 * Automatically syncs the SQLite database file to/from GitHub:
 * - On startup: pulls latest database from GitHub
 * - On data changes: periodically commits and pushes to GitHub
 * 
 * This solves the Render free tier ephemeral filesystem problem.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'review.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const GIT_BRANCH = 'data';
const SYNC_INTERVAL = process.env.SYNC_INTERVAL ? parseInt(process.env.SYNC_INTERVAL) : 60000; // 1 minute
const GIT_TOKEN = process.env.GIT_TOKEN; // GitHub PAT for push

let syncTimer = null;
let hasChanges = false;
let isSyncing = false;
let gitReady = false;

function runGit(cmd, options = {}) {
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });
    return result.trim();
  } catch (e) {
    console.log('[db-sync] git cmd failed:', cmd, e.message);
    return null;
  }
}

/**
 * Initialize Git for data persistence
 */
function init() {
  // Check if git is available
  const gitCheck = runGit('which git');
  if (!gitCheck) {
    console.log('[db-sync] git not available, persistence disabled');
    return false;
  }

  // Check if we're in a git repo
  const repoCheck = runGit('git rev-parse --git-dir');
  if (!repoCheck) {
    console.log('[db-sync] not in a git repo, persistence disabled');
    return false;
  }

  // Configure git
  runGit('git config user.email "bot@jetour.com"');
  runGit('git config user.name "DB Sync Bot"');

  // Set up authenticated remote if GIT_TOKEN is provided (for Render)
  if (GIT_TOKEN) {
    const repoUrl = runGit('git remote get-url origin');
    if (repoUrl) {
      // Extract repo path from existing remote URL
      let repoPath = repoUrl;
      if (repoPath.startsWith('https://')) {
        repoPath = repoPath.replace(/https:\/\/[^@]*@/, 'https://');
        repoPath = repoPath.replace('https://github.com/', '');
        repoPath = repoPath.replace('.git', '');
      }
      const authUrl = 'https://Jevon-chen:' + GIT_TOKEN + '@github.com/' + repoPath;
      runGit('git remote set-url origin ' + authUrl);
      console.log('[db-sync] configured authenticated git remote');
    }
  }

  // Check if data branch exists remotely
  const branchCheck = runGit('git ls-remote --heads origin data');
  
  if (branchCheck) {
    // Data branch exists, fetch and checkout
    console.log('[db-sync] data branch found, pulling latest...');
    runGit('git fetch origin data');
    
    // We need to get the db file without disrupting current branch
    // Create a temp clone approach: checkout just the data files
    const tmpDir = path.join(__dirname, '.db-tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    
    // Use git show to extract files from data branch
    const dbContent = runGit('git show origin/data:data/review.db -- 2>/dev/null', { 
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024 
    });
    
    if (dbContent && dbContent.length > 0) {
      // Only overwrite if remote db exists and is valid
      if (!fs.existsSync(DB_FILE) || fs.statSync(DB_FILE).size === 0) {
        fs.writeFileSync(DB_FILE, dbContent);
        console.log('[db-sync] restored database from GitHub (' + dbContent.length + ' bytes)');
      } else {
        // Local db exists, keep local (it has seed data)
        console.log('[db-sync] local db exists, keeping local version');
      }
    }
  } else {
    console.log('[db-sync] no data branch yet, will create on first sync');
  }

  gitReady = true;
  return true;
}

/**
 * Mark that data has changed and needs to be synced
 */
function markDirty() {
  hasChanges = true;
}

/**
 * Sync database to GitHub
 */
function sync() {
  if (!gitReady || isSyncing || !hasChanges) return;
  
  isSyncing = true;
  
  try {
    // Check if db file exists
    if (!fs.existsSync(DB_FILE)) {
      isSyncing = false;
      return;
    }

    const dbSize = fs.statSync(DB_FILE).size;
    if (dbSize === 0) {
      isSyncing = false;
      return;
    }

    console.log('[db-sync] syncing database (' + dbSize + ' bytes)...');

    // Save current branch
    const currentBranch = runGit('git rev-parse --abbrev-ref HEAD');
    
    // Stash any uncommitted changes on current branch
    runGit('git stash --include-untracked 2>/dev/null');
    
    // Create or switch to data branch
    const localDataBranch = runGit('git branch --list data');
    if (localDataBranch) {
      runGit('git checkout data');
    } else {
      // Create orphan data branch (no history from code branch)
      runGit('git checkout --orphan data');
    }

    // Remove all tracked files in data branch (we only want db files)
    runGit('git rm -rf . 2>/dev/null');
    
    // Re-add only the database and uploads
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    
    // Copy db to a temp location, then back (to avoid git seeing it as removed)
    runGit('git add -f data/review.db 2>/dev/null');
    runGit('git add -f uploads/ 2>/dev/null');
    
    // Create .gitignore for data branch
    fs.writeFileSync(path.join(__dirname, '.gitignore'), 'node_modules/\n*.log\n.DS_Store\n');
    runGit('git add -f .gitignore');
    
    const commitResult = runGit('git commit -m "db-sync: ' + new Date().toISOString() + '"');
    
    if (commitResult) {
      // Push to data branch
      const pushResult = runGit('git push origin data --force');
      if (pushResult !== null) {
        console.log('[db-sync] database synced to GitHub');
        hasChanges = false;
      } else {
        console.log('[db-sync] push failed, will retry next cycle');
      }
    }
    
    // Switch back to original branch
    if (currentBranch && currentBranch !== 'data') {
      runGit('git checkout ' + currentBranch);
    }
    
    // Restore stashed changes
    runGit('git stash pop 2>/dev/null');
    
  } catch (e) {
    console.log('[db-sync] sync error:', e.message);
    // Try to recover: switch back to master
    runGit('git checkout master 2>/dev/null');
    runGit('git stash pop 2>/dev/null');
  }
  
  isSyncing = false;
}

/**
 * Start the periodic sync timer
 */
function startAutoSync() {
  if (!gitReady) return;
  
  console.log('[db-sync] auto-sync enabled, interval: ' + SYNC_INTERVAL + 'ms');
  
  // Sync on interval
  syncTimer = setInterval(() => {
    sync();
  }, SYNC_INTERVAL);
  
  // Sync on graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[db-sync] SIGTERM received, final sync...');
    if (hasChanges) sync();
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    console.log('[db-sync] SIGINT received, final sync...');
    if (hasChanges) sync();
    process.exit(0);
  });
}

/**
 * Stop auto sync
 */
function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

module.exports = {
  init,
  markDirty,
  sync,
  startAutoSync,
  stopAutoSync
};
