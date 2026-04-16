package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// webWizardHTML is the embedded setup page served when the user double-clicks ai-monitor.exe.
const webWizardHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Token 监控 - 安装向导</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #1e293b; border-radius: 16px; box-shadow: 0 25px 50px rgba(0,0,0,0.5); padding: 40px; width: 500px; max-width: 95vw; }
  h1 { font-size: 24px; text-align: center; margin-bottom: 8px; color: #38bdf8; }
  .subtitle { text-align: center; color: #94a3b8; margin-bottom: 28px; font-size: 14px; }
  .field { margin-bottom: 18px; }
  .field label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; font-weight: 500; }
  .field input, .field select { width: 100%; padding: 10px 14px; border: 1px solid #334155; border-radius: 8px; background: #0f172a; color: #e2e8f0; font-size: 14px; outline: none; transition: border-color 0.2s; }
  .field input:focus { border-color: #38bdf8; }
  .field input::placeholder { color: #475569; }
  .field .hint { font-size: 12px; color: #64748b; margin-top: 4px; }
  .row { display: flex; gap: 12px; }
  .row .field { flex: 1; }
  button { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn-primary { background: linear-gradient(135deg, #0ea5e9, #6366f1); color: white; margin-top: 8px; }
  .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .btn-secondary { background: transparent; border: 1px solid #475569; color: #94a3b8; margin-top: 8px; }
  .btn-secondary:hover { border-color: #38bdf8; color: #e2e8f0; }
  #status { margin-top: 20px; padding: 12px; border-radius: 8px; font-size: 13px; display: none; line-height: 1.6; }
  #status.success { display: block; background: #064e3b; color: #6ee7b7; border: 1px solid #065f46; }
  #status.error { display: block; background: #450a0a; color: #fca5a5; border: 1px solid #7f1d1d; }
  #status.info { display: block; background: #1e3a5f; color: #93c5fd; border: 1px solid #1e40af; }
  .logo { text-align: center; margin-bottom: 16px; font-size: 40px; }
  .advanced-toggle { text-align: center; margin: 12px 0; }
  .advanced-toggle a { color: #64748b; font-size: 12px; cursor: pointer; text-decoration: none; }
  .advanced-toggle a:hover { color: #94a3b8; }
  .advanced { display: none; }
  .advanced.show { display: block; }
  .step { display: none; }
  .step.active { display: block; }
  .tabs { display: flex; gap: 0; margin-bottom: 24px; border-bottom: 2px solid #334155; }
  .tab { flex: 1; padding: 10px 0; text-align: center; font-size: 14px; font-weight: 600; color: #64748b; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
  .tab:hover { color: #94a3b8; }
  .tab.active { color: #38bdf8; border-bottom-color: #38bdf8; }
  .auth-form { display: none; }
  .auth-form.active { display: block; }
  .auth-msg { margin-top: 12px; padding: 10px; border-radius: 8px; font-size: 13px; display: none; }
  .auth-msg.error { display: block; background: #450a0a; color: #fca5a5; border: 1px solid #7f1d1d; }
  .auth-msg.success { display: block; background: #064e3b; color: #6ee7b7; border: 1px solid #065f46; }
  .user-info { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .user-info .user-name { font-size: 16px; font-weight: 600; color: #38bdf8; }
  .user-info .user-detail { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  .step-indicator { display: flex; justify-content: center; gap: 8px; margin-bottom: 24px; }
  .step-dot { width: 8px; height: 8px; border-radius: 50%; background: #334155; transition: background 0.3s; }
  .step-dot.active { background: #38bdf8; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🔍</div>
  <h1>AI Token 监控</h1>
  <p class="subtitle">安装后自动记录所有开发工具的 AI Token 使用量</p>
  <div class="step-indicator">
    <div class="step-dot active" id="dot1"></div>
    <div class="step-dot" id="dot2"></div>
  </div>

  <!-- ========== Step 1: 认证 ========== -->
  <div class="step active" id="step1">
    <div class="field">
      <label>上报服务器</label>
      <input id="serverUrl" type="text" value="{{.ServerURL}}" placeholder="{{.ServerURL}}" />
      <div class="hint">公司内部部署的统计服务器地址</div>
    </div>

    <div class="tabs">
      <div class="tab active" onclick="switchTab('register')">注册</div>
      <div class="tab" onclick="switchTab('login')">登录</div>
      <div class="tab" onclick="switchTab('bind')">绑定已有账号</div>
    </div>

    <!-- 注册表单 -->
    <div class="auth-form active" id="registerForm">
      <div class="field">
        <label>姓名 *</label>
        <input id="regName" type="text" value="{{.UserName}}" required placeholder="真实姓名" />
      </div>
      <div class="field">
        <label>邮箱 *</label>
        <input id="regEmail" type="email" placeholder="例如：zhangsan@company.com" />
      </div>
      <div class="field">
        <label>部门</label>
        <input id="regDept" type="text" placeholder="例如：公共技术部" />
      </div>
      <div class="row">
        <div class="field">
          <label>密码 *</label>
          <input id="regPwd" type="password" placeholder="至少4位" />
        </div>
        <div class="field">
          <label>确认密码 *</label>
          <input id="regPwd2" type="password" placeholder="再次输入" />
        </div>
      </div>
      <button class="btn-primary" id="regBtn" onclick="doRegister()">注册</button>
      <div class="auth-msg" id="regMsg"></div>
    </div>

    <!-- 登录表单 -->
    <div class="auth-form" id="loginForm">
      <div class="field">
        <label>邮箱</label>
        <input id="loginId" type="text" placeholder="注册时使用的邮箱" />
      </div>
      <div class="field">
        <label>密码</label>
        <input id="loginPwd" type="password" placeholder="密码" />
      </div>
      <button class="btn-primary" id="loginBtn" onclick="doLogin()">登录</button>
      <div class="auth-msg" id="loginMsg"></div>
    </div>

    <!-- 绑定已有账号 -->
    <div class="auth-form" id="bindForm">
      <div class="hint" style="margin-bottom:16px;color:#94a3b8;">已有工号但还没绑定邮箱？输入原工号和姓名验证身份后，即可绑定邮箱，历史数据全部保留。</div>
      <div class="row">
        <div class="field">
          <label>原工号 *</label>
          <input id="bindEid" type="text" placeholder="例如：10001" />
        </div>
        <div class="field">
          <label>姓名 *</label>
          <input id="bindName" type="text" value="{{.UserName}}" placeholder="与工号对应的姓名" />
        </div>
      </div>
      <div class="field">
        <label>邮箱 *</label>
        <input id="bindEmail" type="email" placeholder="绑定后用邮箱登录" />
      </div>
      <div class="row">
        <div class="field">
          <label>设置密码 *</label>
          <input id="bindPwd" type="password" placeholder="至少4位" />
        </div>
        <div class="field">
          <label>确认密码 *</label>
          <input id="bindPwd2" type="password" placeholder="再次输入" />
        </div>
      </div>
      <button class="btn-primary" id="bindBtn" onclick="doBind()">绑定邮箱</button>
      <div class="auth-msg" id="bindMsg"></div>
    </div>
  </div>

  <!-- ========== Step 2: 安装 ========== -->
  <div class="step" id="step2">
    <div class="user-info">
      <div class="user-name" id="displayName"></div>
      <div class="user-detail" id="displayDetail"></div>
    </div>

    <div class="advanced-toggle"><a onclick="toggleAdvanced()">▶ 高级选项</a></div>
    <div class="advanced" id="advancedSection">
      <div class="field">
        <label>上游代理（可选）</label>
        <input id="upstreamProxy" type="text" placeholder="如 socks5://127.0.0.1:7890（访问外网用的代理）" />
        <div class="hint">如果你的电脑需要代理才能上外网，在此填写代理地址</div>
      </div>
      <div class="field">
        <label>监听端口</label>
        <input id="port" type="number" value="18090" min="1024" max="65535" />
      </div>
    </div>

    <button class="btn-primary" id="installBtn" onclick="doInstall()">一键安装</button>
    <button class="btn-secondary" onclick="backToStep1()">返回修改账号</button>
    <div id="status"></div>
  </div>
</div>

<script>
var authUser = null;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.auth-form').forEach(function(f){ f.classList.remove('active'); });
  var tabs = document.querySelectorAll('.tabs .tab');
  if (tab === 'register') {
    tabs[0].classList.add('active');
    document.getElementById('registerForm').classList.add('active');
  } else if (tab === 'login') {
    tabs[1].classList.add('active');
    document.getElementById('loginForm').classList.add('active');
  } else {
    tabs[2].classList.add('active');
    document.getElementById('bindForm').classList.add('active');
  }
  hideMsg('regMsg'); hideMsg('loginMsg'); hideMsg('bindMsg');
}

function showMsg(id, text, level) {
  var el = document.getElementById(id);
  el.className = 'auth-msg ' + level;
  el.textContent = text;
}
function hideMsg(id) {
  var el = document.getElementById(id);
  el.className = 'auth-msg';
  el.style.display = 'none';
  el.textContent = '';
}

function getServerUrl() {
  return document.getElementById('serverUrl').value.trim().replace(/\/+$/, '');
}

async function doRegister() {
  var name = document.getElementById('regName').value.trim();
  var email = document.getElementById('regEmail').value.trim();
  var dept = document.getElementById('regDept').value.trim();
  var pwd = document.getElementById('regPwd').value;
  var pwd2 = document.getElementById('regPwd2').value;
  if (!name) { showMsg('regMsg', '请填写姓名', 'error'); return; }
  if (!email) { showMsg('regMsg', '请填写邮箱', 'error'); return; }
  if (!pwd || pwd.length < 4) { showMsg('regMsg', '密码至少4位', 'error'); return; }
  if (pwd !== pwd2) { showMsg('regMsg', '两次密码不一致', 'error'); return; }
  if (!getServerUrl()) { showMsg('regMsg', '请填写上报服务器地址', 'error'); return; }

  var btn = document.getElementById('regBtn');
  btn.disabled = true; btn.textContent = '注册中…';
  hideMsg('regMsg');

  try {
    var resp = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_url: getServerUrl(), name: name, email: email, department: dept, password: pwd }),
    });
    var data = await resp.json();
    if (resp.ok && data.employee_id) {
      authUser = { employee_id: data.employee_id, name: data.name || name, department: data.department || dept, auth_token: data.auth_token || '' };
      showMsg('regMsg', '注册成功！', 'success');
      setTimeout(function(){ goToStep2(); }, 800);
    } else {
      showMsg('regMsg', data.detail || data.message || '注册失败', 'error');
    }
  } catch(err) {
    showMsg('regMsg', '网络错误: ' + err.message, 'error');
  }
  btn.disabled = false; btn.textContent = '注册';
}

async function doLogin() {
  var id = document.getElementById('loginId').value.trim();
  var pwd = document.getElementById('loginPwd').value;
  if (!id || !pwd) { showMsg('loginMsg', '请填写邮箱和密码', 'error'); return; }
  if (!getServerUrl()) { showMsg('loginMsg', '请填写上报服务器地址', 'error'); return; }

  var btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '登录中…';
  hideMsg('loginMsg');

  try {
    var resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_url: getServerUrl(), email: id, password: pwd }),
    });
    var data = await resp.json();
    if (resp.ok && data.employee_id) {
      authUser = { employee_id: data.employee_id, name: data.name || '', department: data.department || '', auth_token: data.auth_token || '' };
      showMsg('loginMsg', '登录成功', 'success');
      setTimeout(function(){ goToStep2(); }, 500);
    } else if (resp.status === 403 && data.detail === 'password_not_set') {
      showMsg('loginMsg', '该账号尚未设置密码，请先注册或联系管理员', 'error');
    } else {
      showMsg('loginMsg', data.detail || data.message || '登录失败', 'error');
    }
  } catch(err) {
    showMsg('loginMsg', '网络错误: ' + err.message, 'error');
  }
  btn.disabled = false; btn.textContent = '登录';
}

async function doBind() {
  var eid = document.getElementById('bindEid').value.trim();
  var name = document.getElementById('bindName').value.trim();
  var email = document.getElementById('bindEmail').value.trim();
  var pwd = document.getElementById('bindPwd').value;
  var pwd2 = document.getElementById('bindPwd2').value;
  if (!eid) { showMsg('bindMsg', '请填写原工号', 'error'); return; }
  if (!name) { showMsg('bindMsg', '请填写姓名', 'error'); return; }
  if (!email) { showMsg('bindMsg', '请填写邮箱', 'error'); return; }
  if (!pwd || pwd.length < 4) { showMsg('bindMsg', '密码至少4位', 'error'); return; }
  if (pwd !== pwd2) { showMsg('bindMsg', '两次密码不一致', 'error'); return; }
  if (!getServerUrl()) { showMsg('bindMsg', '请填写上报服务器地址', 'error'); return; }

  var btn = document.getElementById('bindBtn');
  btn.disabled = true; btn.textContent = '绑定中…';
  hideMsg('bindMsg');

  try {
    var resp = await fetch('/api/auth/bind-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_url: getServerUrl(), employee_id: eid, name: name, email: email, password: pwd }),
    });
    var data = await resp.json();
    if (resp.ok && data.employee_id) {
      authUser = { employee_id: data.employee_id, name: data.name || name, department: data.department || '', auth_token: data.auth_token || '' };
      showMsg('bindMsg', '绑定成功！历史数据已保留。', 'success');
      setTimeout(function(){ goToStep2(); }, 800);
    } else {
      var msg = data.detail || data.message || '绑定失败';
      if (resp.status === 403) msg = '姓名与该工号记录不匹配';
      if (resp.status === 404) msg = '未找到该工号对应的账号';
      if (resp.status === 409) msg = '该邮箱已被其他账号使用';
      showMsg('bindMsg', msg, 'error');
    }
  } catch(err) {
    showMsg('bindMsg', '网络错误: ' + err.message, 'error');
  }
  btn.disabled = false; btn.textContent = '绑定邮箱';
}

function goToStep2() {
  document.getElementById('step1').classList.remove('active');
  document.getElementById('step2').classList.add('active');
  document.getElementById('dot1').classList.remove('active');
  document.getElementById('dot2').classList.add('active');
  if (authUser) {
    document.getElementById('displayName').textContent = authUser.name + '（' + authUser.employee_id + '）';
    var detail = '';
    if (authUser.department) detail += '部门：' + authUser.department + '  ';
    detail += '服务器：' + getServerUrl();
    document.getElementById('displayDetail').textContent = detail;
  }
}

function backToStep1() {
  document.getElementById('step2').classList.remove('active');
  document.getElementById('step1').classList.add('active');
  document.getElementById('dot2').classList.remove('active');
  document.getElementById('dot1').classList.add('active');
  document.getElementById('status').className = '';
  document.getElementById('status').style.display = 'none';
}

function toggleAdvanced() {
  document.getElementById('advancedSection').classList.toggle('show');
}

async function doInstall() {
  if (!authUser) { alert('请先登录或注册'); backToStep1(); return; }
  var btn = document.getElementById('installBtn');
  var status = document.getElementById('status');
  btn.disabled = true; btn.textContent = '正在安装...';
  status.className = 'info'; status.style.display = 'block';
  status.textContent = '正在安装证书、配置环境变量、注册开机自启...';

  try {
    var resp = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_name: authUser.name,
        user_id: authUser.employee_id,
        department: authUser.department,
        server_url: getServerUrl(),
        upstream_proxy: document.getElementById('upstreamProxy').value.trim(),
        port: parseInt(document.getElementById('port').value) || 18090,
      }),
    });
    var result = await resp.json();
    if (result.success) {
      status.className = 'success';
      status.innerHTML = '✓ 安装成功！<br><br>' + result.message.replace(/\n/g, '<br>') + '<br><br>此页面可以关闭了。';
      btn.textContent = '✓ 已完成';
    } else {
      status.className = 'error';
      status.textContent = '✗ ' + result.message;
      btn.disabled = false; btn.textContent = '重试安装';
    }
  } catch(err) {
    status.className = 'error';
    status.textContent = '✗ 网络错误: ' + err.message;
    btn.disabled = false; btn.textContent = '重试安装';
  }
}
</script>
</body>
</html>`

type setupRequest struct {
	UserName      string `json:"user_name"`
	UserID        string `json:"user_id"`
	Department    string `json:"department"`
	ServerURL     string `json:"server_url"`
	UpstreamProxy string `json:"upstream_proxy"`
	Port          int    `json:"port"`
}

type setupResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// runWebWizard starts a local web server with a setup page and opens it in the browser.
// Blocks until the user completes setup or closes the page.
func runWebWizard(configPath string, certMgr *CertManager) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("无法启动本地 Web 服务: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	wizardURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	done := make(chan struct{})
	var setupErr error

	mux := http.NewServeMux()

	// Serve the setup page
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		tmpl, err := template.New("wizard").Parse(webWizardHTML)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		data := struct {
			UserName  string
			ServerURL string
		}{
			UserName:  getOSUserName(),
			ServerURL: DefaultServerURL,
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		tmpl.Execute(w, data)
	})

	// Proxy auth requests to the remote server (register / login)
	mux.HandleFunc("/api/auth/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", 405)
			return
		}

		var reqBody struct {
			ServerURL string `json:"server_url"`
		}
		bodyBytes, _ := io.ReadAll(r.Body)
		r.Body.Close()
		json.Unmarshal(bodyBytes, &reqBody)

		serverURL := strings.TrimRight(strings.TrimSpace(reqBody.ServerURL), "/")
		if serverURL == "" {
			serverURL = DefaultServerURL
		}

		authPath := strings.TrimPrefix(r.URL.Path, "/api/auth/")
		targetURL := serverURL + "/api/auth/" + authPath

		client := &http.Client{Timeout: 15 * time.Second}
		proxyReq, err := http.NewRequest("POST", targetURL, bytes.NewReader(bodyBytes))
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(502)
			json.NewEncoder(w).Encode(map[string]string{"detail": "请求构建失败: " + err.Error()})
			return
		}
		proxyReq.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(proxyReq)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(502)
			json.NewEncoder(w).Encode(map[string]string{"detail": "无法连接服务器: " + err.Error()})
			return
		}
		defer resp.Body.Close()

		respBody, _ := io.ReadAll(resp.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(respBody)
	})

	// Handle setup submission
	mux.HandleFunc("/api/setup", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", 405)
			return
		}

		var req setupRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(setupResponse{Success: false, Message: "请求格式错误: " + err.Error()})
			return
		}

		if strings.TrimSpace(req.UserName) == "" {
			json.NewEncoder(w).Encode(setupResponse{Success: false, Message: "姓名不能为空"})
			return
		}

		// Build config
		cfg := &Config{
			ServerURL:     strings.TrimRight(strings.TrimSpace(req.ServerURL), "/"),
			UserName:      strings.TrimSpace(req.UserName),
			UserID:        strings.TrimSpace(req.UserID),
			Department:    strings.TrimSpace(req.Department),
			Port:          req.Port,
			UpstreamProxy: strings.TrimSpace(req.UpstreamProxy),
		}
		if cfg.ServerURL == "" {
			cfg.ServerURL = DefaultServerURL
		}
		if cfg.UserID == "" {
			cfg.UserID = generateUserID()
		}
		if cfg.Port <= 0 || cfg.Port > 65535 {
			cfg.Port = 18090
		}

		if err := validateServerURL(cfg.ServerURL); err != nil {
			json.NewEncoder(w).Encode(setupResponse{Success: false, Message: "服务器地址无效: " + err.Error()})
			return
		}
		if cfg.UpstreamProxy != "" {
			if err := validateUpstreamProxyURL(cfg.UpstreamProxy); err != nil {
				json.NewEncoder(w).Encode(setupResponse{Success: false, Message: "上游代理地址无效: " + err.Error()})
				return
			}
		}

		// Save config.json
		absConfigPath, _ := filepath.Abs(configPath)
		data, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			json.NewEncoder(w).Encode(setupResponse{Success: false, Message: "配置序列化失败: " + err.Error()})
			return
		}
		if err := os.WriteFile(absConfigPath, data, 0644); err != nil {
			json.NewEncoder(w).Encode(setupResponse{Success: false, Message: "保存配置失败: " + err.Error()})
			return
		}

		// Save identity.json for VSCode extension to read
		identityPath := filepath.Join(os.Getenv("APPDATA"), "ai-monitor", "identity.json")
		os.MkdirAll(filepath.Dir(identityPath), 0755)
		identityData, _ := json.MarshalIndent(map[string]string{
			"user_id":    cfg.UserID,
			"user_name":  cfg.UserName,
			"department": cfg.Department,
		}, "", "  ")
		os.WriteFile(identityPath, identityData, 0644)

		// Run global install (CA + env vars + auto-start)
		var messages []string

		// Step 0: Detect existing upstream proxy BEFORE overwriting
		detectedUpstream := detectUpstreamProxy(cfg)
		previousSysProxy := readCurrentSystemProxy()
		previousEnvVars := snapshotProxyEnvVars()

		if detectedUpstream != "" {
			messages = append(messages, fmt.Sprintf("ℹ 检测到已有代理: %s（将作为上游保留）", detectedUpstream))
			if strings.TrimSpace(cfg.UpstreamProxy) == "" {
				cfg.UpstreamProxy = detectedUpstream
				// Re-save config with upstream_proxy
				data, _ = json.MarshalIndent(cfg, "", "  ")
				os.WriteFile(absConfigPath, data, 0644)
			}
		}

		// 1. Install CA
		if err := certMgr.InstallCA(); err != nil {
			messages = append(messages, "⚠ CA 证书安装失败: "+err.Error())
		} else {
			messages = append(messages, "✓ CA 证书已安装")
		}

		// 2. Set user-level env vars + system proxy
		actualPort := resolveActualPort(cfg)
		proxyAddr := fmt.Sprintf("localhost:%d", actualPort)
		httpProxy := "http://" + proxyAddr
		noProxy := buildNoProxyEnvWithConfig(cfg)
		envVars := map[string]string{
			"HTTP_PROXY":          httpProxy,
			"HTTPS_PROXY":         httpProxy,
			"NO_PROXY":            noProxy,
			"NODE_EXTRA_CA_CERTS": certMgr.CACertPath(),
		}
		if err := SetEnvProxy(envVars); err != nil {
			messages = append(messages, "⚠ 环境变量设置失败: "+err.Error())
		} else {
			messages = append(messages, "✓ 环境变量已设置 (HTTP_PROXY 等)")
		}

		// 2b. System proxy via PAC (with DIRECT fallback for crash safety)
		previousAutoConfigURL := ReadCurrentAutoConfigURL()
		pacURL, pacErr := writePACFile(actualPort, cfg)
		saveInstallState(&InstallState{
			SystemProxySet:        true,
			PreviousProxyAddr:     previousSysProxy,
			PreviousProxyEnabled:  previousSysProxy != "" && !isSelfProxy(previousSysProxy),
			PreviousUpstreamProxy: detectedUpstream,
			PreviousEnvVars:       previousEnvVars,
			PACFileSet:            true,
			PACFilePath:           pacFilePath(),
			PreviousAutoConfigURL: previousAutoConfigURL,
		})
		if pacErr != nil {
			messages = append(messages, "⚠ PAC 文件生成失败: "+pacErr.Error())
		} else if err := EnableSystemProxyPAC(pacURL); err != nil {
			messages = append(messages, "⚠ 系统代理 (PAC) 设置失败: "+err.Error())
		} else {
			messages = append(messages, "✓ 系统代理已设置 (PAC + DIRECT 回退，异常时不断网)")
		}

		// 3. Register auto-start
		if err := installAutoStart(absConfigPath); err != nil {
			messages = append(messages, "⚠ 开机自启注册失败: "+err.Error())
		} else {
			messages = append(messages, "✓ 已注册开机自启")
		}

		// 4. Start background instance
		if _, alive := checkExistingInstance(); !alive {
			if err := startBackgroundInstance(absConfigPath); err != nil {
				messages = append(messages, "⚠ 后台启动失败: "+err.Error())
			} else {
				messages = append(messages, "✓ ai-monitor 已在后台启动")
			}
		} else {
			messages = append(messages, "✓ ai-monitor 已在运行中")
		}

		messages = append(messages, "")
		messages = append(messages, "重新打开 IDE 和终端即可生效。")

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(setupResponse{
			Success: true,
			Message: strings.Join(messages, "\n"),
		})

		// Signal completion after a short delay (let response send)
		go func() {
			time.Sleep(500 * time.Millisecond)
			close(done)
		}()
	})

	server := &http.Server{Handler: mux}

	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			setupErr = err
			close(done)
		}
	}()

	log.Printf("[wizard] 安装向导已启动: %s", wizardURL)
	openBrowser(wizardURL)

	fmt.Println()
	fmt.Println("  ╔══════════════════════════════════════════╗")
	fmt.Println("  ║   安装向导已在浏览器中打开                ║")
	fmt.Printf("  ║   %s            ║\n", wizardURL)
	fmt.Println("  ║   请在浏览器中完成配置                    ║")
	fmt.Println("  ╚══════════════════════════════════════════╝")
	fmt.Println()

	// Wait for setup completion or timeout (10 minutes)
	select {
	case <-done:
	case <-time.After(10 * time.Minute):
		log.Println("[wizard] 超时，关闭向导")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	server.Shutdown(ctx)

	return setupErr
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/C", "start", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start()
}
