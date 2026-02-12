import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { connection, wallet } from '../core/connection';
import { CONFIG } from '../config';

export class DashboardServer {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private port: number;
  private modules: any = {};
  private recentAlerts: Array<{ time: number; type: string; message: string }> = [];
  private tradeLog: Array<{ time: number; action: string; mint: string; amount: number; tx?: string }> = [];
  private performanceHistory: Array<{ time: number; balanceSol: number }> = [];

  constructor(port: number = 3000) {
    this.port = port;
    this.app.use(cors());
    this.app.use(express.json());
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.setupRoutes();
    this.setupWebSocket();
  }

  setModules(modules: any) { this.modules = modules; }

  private setupRoutes() {
    this.app.get('/api/status', async (_req, res) => {
      try {
        const bal = await connection.getBalance(wallet.publicKey);
        res.json({
          status: 'running', wallet: wallet.publicKey.toBase58(),
          balanceSol: bal / 1e9, uptime: process.uptime(),
          modules: { sniper: !!this.modules.sniper, tracker: !!this.modules.tracker, monitor: !!this.modules.monitor, pumpfun: !!this.modules.pumpfun, social: !!this.modules.social },
          config: CONFIG.trading,
        });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/positions', (_req, res) => {
      res.json({ positions: this.modules.positions?.getPositions() || [] });
    });

    this.app.get('/api/trades', (_req, res) => res.json({ trades: this.tradeLog.slice(-100) }));
    this.app.get('/api/alerts', (_req, res) => res.json({ alerts: this.recentAlerts.slice(-50) }));
    this.app.get('/api/wallets', (_req, res) => res.json({ wallets: this.modules.tracker?.listWallets() || [] }));

    this.app.post('/api/wallets', (req, res) => {
      const { address, label, copyPct, minTradeSol } = req.body;
      if (!address || !label) return res.status(400).json({ error: 'address and label required' });
      this.modules.tracker?.addWallet({ address, label, copyPct: copyPct || 50, minTradeSol: minTradeSol || 0.5, enabled: true });
      res.json({ success: true });
    });

    this.app.get('/api/performance', (_req, res) => res.json({ history: this.performanceHistory }));
    this.app.get('/api/pumpfun/stats', (_req, res) => res.json(this.modules.pumpfun?.getStats() || {}));

    this.app.get('/api/social/stats', (_req, res) => {
      const stats = this.modules.social?.getStats() || {};
      const narr = this.modules.social?.getActiveNarratives() || new Map();
      res.json({ ...stats, narratives: [...narr.entries()].map(([k, v]: any) => ({ keyword: k, ...v })) });
    });

    this.app.post('/api/config', (req, res) => {
      const { maxBuySol, slippageBps, profitTarget, stopLoss } = req.body;
      if (maxBuySol !== undefined) CONFIG.trading.maxBuySol = maxBuySol;
      if (slippageBps !== undefined) CONFIG.trading.slippageBps = slippageBps;
      if (profitTarget !== undefined) CONFIG.trading.profitTarget = profitTarget;
      if (stopLoss !== undefined) CONFIG.trading.stopLoss = stopLoss;
      res.json({ success: true, config: CONFIG.trading });
    });

    // Serve dashboard HTML
    this.app.get('*', (_req, res) => {
      res.send(this.getDashboardHTML());
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });
  }

  broadcast(type: string, data: any) {
    const msg = JSON.stringify({ type, data, timestamp: Date.now() });
    for (const c of this.clients) { if (c.readyState === WebSocket.OPEN) c.send(msg); }
  }

  addAlert(type: string, message: string) {
    const alert = { time: Date.now(), type, message };
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > 200) this.recentAlerts.shift();
    this.broadcast('alert', alert);
  }

  addTrade(action: string, mint: string, amount: number, tx?: string) {
    const trade = { time: Date.now(), action, mint, amount, tx };
    this.tradeLog.push(trade);
    this.broadcast('trade', trade);
  }

  updatePerformance(balanceSol: number) {
    this.performanceHistory.push({ time: Date.now(), balanceSol });
    this.broadcast('performance', { time: Date.now(), balanceSol });
  }

  async start() {
    return new Promise<void>((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`🌐 Dashboard: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Solana Bot Dashboard</title>
<style>
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a2e;--border:#2a2a3e;--primary:#7c3aed;--green:#10b981;--red:#ef4444;--text:#e2e8f0;--dim:#94a3b8;--muted:#64748b}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:20px;background:linear-gradient(135deg,#a78bfa,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.status{display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;font-size:13px;background:rgba(16,185,129,.15);color:var(--green)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.card-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:12px}
.metric{font-size:28px;font-weight:700}
.green{color:var(--green)}.red{color:var(--red)}
.sub{font-size:13px;color:var(--dim);margin-top:4px}
.wide{grid-column:span 2}.full{grid-column:span 4}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;border-bottom:1px solid var(--border)}
td{padding:12px;border-bottom:1px solid var(--border)}
tr:hover{background:var(--surface2)}
.feed{max-height:400px;overflow-y:auto}
.alert-item{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}
.alert-time{color:var(--muted);font-size:11px;min-width:60px}
.cfg-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.cfg-item label{font-size:12px;color:var(--muted)}
.cfg-item input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);margin-top:4px}
.btn{padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;background:var(--primary);color:white}
.modules-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mod{background:var(--surface2);border-radius:8px;padding:10px;display:flex;justify-content:space-between;font-size:13px}
.on{color:var(--green)}.off{color:var(--red)}
</style></head><body>
<div class="header"><h1>🤖 Solana Memecoin Bot</h1><div class="status" id="status"><div class="dot"></div><span id="st">Connecting...</span></div></div>
<div class="grid">
<div class="card"><div class="card-title">💰 Balance</div><div class="metric" id="bal">--</div><div class="sub" id="bal-usd"></div></div>
<div class="card"><div class="card-title">📈 Total P&L</div><div class="metric green" id="pnl">+0.00 SOL</div></div>
<div class="card"><div class="card-title">📊 Win Rate</div><div class="metric" id="wr">--%</div><div class="sub" id="tc">0 trades</div></div>
<div class="card"><div class="card-title">🎯 Positions</div><div class="metric" id="pos">0</div></div>

<div class="card wide"><div class="card-title">⚙️ Modules</div><div class="modules-grid">
<div class="mod"><span>🎯 Sniper</span><span class="on" id="m-sniper">ON</span></div>
<div class="mod"><span>👀 Copy-Trade</span><span class="on" id="m-tracker">ON</span></div>
<div class="mod"><span>📊 Monitor</span><span class="on" id="m-monitor">ON</span></div>
<div class="mod"><span>🟣 Pump.fun</span><span class="on" id="m-pumpfun">ON</span></div>
<div class="mod"><span>📱 Social</span><span class="on" id="m-social">ON</span></div>
<div class="mod"><span>📊 Backtest</span><span class="on">READY</span></div>
</div></div>

<div class="card wide"><div class="card-title">⚙️ Config</div><div class="cfg-grid">
<div class="cfg-item"><label>Max Buy (SOL)</label><input type="number" id="c-buy" step="0.01" value="0.1"></div>
<div class="cfg-item"><label>Slippage (BPS)</label><input type="number" id="c-slip" step="50" value="500"></div>
<div class="cfg-item"><label>Take Profit %</label><input type="number" id="c-tp" step="10" value="100"></div>
<div class="cfg-item"><label>Stop Loss %</label><input type="number" id="c-sl" step="5" value="50"></div>
</div><button class="btn" style="margin-top:12px;width:100%" onclick="saveCfg()">Save</button></div>

<div class="card full"><div class="card-title">📌 Open Positions</div><table><thead><tr><th>Token</th><th>Entry</th><th>Current</th><th>P&L</th><th>Source</th></tr></thead><tbody id="pos-body"><tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">No positions</td></tr></tbody></table></div>

<div class="card wide"><div class="card-title">🔔 Live Alerts</div><div class="feed" id="feed"><div class="alert-item"><span class="alert-time">--:--</span><span>Waiting...</span></div></div></div>

<div class="card wide"><div class="card-title">👀 Tracked Wallets</div><div id="wlist" style="font-size:13px">Loading...</div><div style="display:flex;gap:8px;margin-top:12px"><input type="text" id="nw" placeholder="Wallet address..." style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);font-size:13px"><button class="btn" onclick="addW()">Add</button></div></div>
</div>

<script>
const A=window.location.origin;let ws;
function connect(){ws=new WebSocket(A.replace('http','ws'));ws.onopen=()=>{document.getElementById('st').textContent='Connected'};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='alert')addAlert(m.data);};ws.onclose=()=>{document.getElementById('st').textContent='Disconnected';setTimeout(connect,3000)}}
async function load(){try{const r=await(await fetch(A+'/api/status')).json();document.getElementById('bal').textContent=r.balanceSol.toFixed(4)+' SOL';document.getElementById('c-buy').value=r.config.maxBuySol;document.getElementById('c-slip').value=r.config.slippageBps;document.getElementById('c-tp').value=r.config.profitTarget;document.getElementById('c-sl').value=r.config.stopLoss;for(const[k,v]of Object.entries(r.modules)){const e=document.getElementById('m-'+k);if(e){e.textContent=v?'ON':'OFF';e.className=v?'on':'off'}}}catch{}}
async function loadAlerts(){try{const r=await(await fetch(A+'/api/alerts')).json();const f=document.getElementById('feed');if(r.alerts.length)f.innerHTML=r.alerts.reverse().slice(0,30).map(a=>'<div class="alert-item"><span class="alert-time">'+new Date(a.time).toLocaleTimeString()+'</span><span>'+a.message+'</span></div>').join('')}catch{}}
async function loadWallets(){try{const r=await(await fetch(A+'/api/wallets')).json();document.getElementById('wlist').innerHTML=r.wallets.length?r.wallets.map(w=>'<div style="padding:6px 0;border-bottom:1px solid var(--border)">'+w.label+' ('+w.copyPct+'%)</div>').join(''):'<div style="color:var(--muted)">No wallets</div>'}catch{}}
function addAlert(a){const f=document.getElementById('feed');f.insertAdjacentHTML('afterbegin','<div class="alert-item"><span class="alert-time">'+new Date(a.time).toLocaleTimeString()+'</span><span>'+a.message+'</span></div>')}
async function saveCfg(){await fetch(A+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxBuySol:+document.getElementById('c-buy').value,slippageBps:+document.getElementById('c-slip').value,profitTarget:+document.getElementById('c-tp').value,stopLoss:+document.getElementById('c-sl').value})})}
async function addW(){const a=document.getElementById('nw').value.trim();if(!a)return;await fetch(A+'/api/wallets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:a,label:a.slice(0,8)+'...',copyPct:50,minTradeSol:0.5})});document.getElementById('nw').value='';loadWallets()}
connect();load();loadAlerts();loadWallets();setInterval(load,30000);setInterval(loadAlerts,15000);
</script></body></html>`;
  }
}
