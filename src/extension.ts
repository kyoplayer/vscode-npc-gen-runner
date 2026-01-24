import * as vscode from "vscode";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as he from "he";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { randomBytes } from "crypto";

const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const accessAsync = promisify(fs.access);

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("npc");
}
function getWorkspaceRoot(): string | undefined {
  const ws = vscode.workspace.workspaceFolders;
  if (!ws || ws.length === 0) return undefined;
  return ws[0].uri.fsPath;
}
function ensureWorkspace(): string {
  const root = getWorkspaceRoot();
  if (!root) throw new Error("Workspace is not opened. Please open a folder first.");
  return root;
}
function defaultCfg() {
  return {
    pythonPath: "py",
    genFilename: "gen.py",
    mainFilename: "main.py",
    timeoutMsGen: 30000,
    timeoutMsMain: 30000,
    timeoutMsScorer: 30000,
    maxOutputBytes: 10 * 1000 * 1000,
    outputDir: ".",
    threads: 0,
    genCommand: "py {wrapper}",
    mainBuildCommand: "g++ main.cpp -o {out}",
    mainBuildEnabled: false,
    mainRunCommand: "py {main}",
    mainExec: "main_exec",
    scorerFilename: "scorer.py",
    scorerRunCommand: "py {scorer}",
    scorerExec: "scorer_exec",
    scorerBuildCommand: "g++ scorer.cpp -o {out}",
    scorerBuildEnabled: false,
    sharedVars: "",
    // judge defaults
    judgeTimeLimitMs: 3000,
    judgeRetries: 3,
    judgeRealTimeoutFactor: 2
  };
}

function safeFilenamePart(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function getPhysicalCoreCount(): number {
  try {
    const platform = process.platform;
    if (platform === "linux") {
      const data = fs.readFileSync("/proc/cpuinfo", "utf8");
      const physCorePairs = new Set<string>();
      const blocks = data.split(/\n\n+/);
      for (const b of blocks) {
        const mPhys = b.match(/^physical id\s*:\s*(\d+)/m);
        const mCore = b.match(/^core id\s*:\s*(\d+)/m);
        if (mPhys && mCore) {
          physCorePairs.add(`${mPhys[1]}-${mCore[1]}`);
        }
      }
      if (physCorePairs.size > 0) return physCorePairs.size;
    } else if (platform === "darwin") {
      const out = execSync("sysctl -n hw.physicalcpu", { encoding: "utf8" }).trim();
      const n = Number(out);
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
    } else if (platform === "win32") {
      try {
        const out = execSync('wmic cpu get NumberOfCores /value', { encoding: "utf8" });
        const matches = Array.from(out.matchAll(/NumberOfCores=(\d+)/g));
        if (matches && matches.length) {
          const sum = matches.reduce((acc: number, m: any) => acc + Number(m[1] || 0), 0);
          if (sum > 0) return sum;
        }
      } catch (e) {}
    }
  } catch (e) {}
  const logical = os.cpus()?.length || 1;
  return Math.max(1, Math.floor(logical));
}

// ---- diagnostic helper ----
function logEnvironment(outputChannel?: vscode.OutputChannel) {
  try {
    if (!outputChannel) return;
    outputChannel.appendLine(`Diagnostics: platform=${process.platform} arch=${process.arch}`);
    outputChannel.appendLine(`Diagnostics: node version=${process.version}`);
    outputChannel.appendLine(`Diagnostics: tmpdir=${os.tmpdir()} cwd=${process.cwd()}`);
    try { outputChannel.appendLine(`Diagnostics: PATH=${process.env.PATH}`); } catch {}
    const which = (cmd: string) => {
      try {
        if (process.platform === 'win32') {
          const out = execSync(`where ${cmd}`, { encoding: 'utf8' }).trim();
          return out.split(/\r?\n/)[0] || null;
        } else {
          const out = execSync(`which ${cmd}`, { encoding: 'utf8' }).trim();
          return out || null;
        }
      } catch (e) { return null; }
    };
    const check = ['python3','python','py','g++','gcc','/usr/bin/time','time','powershell','pwsh','wmic'];
    for (const c of check) {
      try {
        const p = which(c);
        outputChannel.appendLine(`Diagnostics: ${c} -> ${p ?? '<not found>'}`);
      } catch {}
    }
  } catch (e:any) {
    try { outputChannel?.appendLine(`Diagnostics helper error: ${String(e)}`); } catch {}
  }
}

function whichSync(cmd: string): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`where ${cmd}`, { encoding: 'utf8' }).trim();
      return out.split(/\r?\n/)[0] || null;
    } else {
      const out = execSync(`which ${cmd}`, { encoding: 'utf8' }).trim();
      return out || null;
    }
  } catch (e) {
    return null;
  }
}

async function generateEnvironmentHelperFile(root: string, outputChannel?: vscode.OutputChannel) {
  try {
    const cmds = ['python3','python','py','g++','gcc','/usr/bin/time','time','powershell','pwsh','wmic'];
    const found: Record<string,string|null> = {};
    for (const c of cmds) found[c] = whichSync(c);

    const suggestions: any = {};
    // python selection
    if (found['python3']) {
      suggestions.pythonPath = 'python3';
      suggestions.genCommand = 'python3 {wrapper}';
      suggestions.mainRunCommand = 'python3 {main}';
      suggestions.scorerRunCommand = 'python3 {scorer}';
    } else if (found['python']) {
      suggestions.pythonPath = 'python';
      suggestions.genCommand = 'python {wrapper}';
      suggestions.mainRunCommand = 'python {main}';
      suggestions.scorerRunCommand = 'python {scorer}';
    } else if (found['py']) {
      suggestions.pythonPath = 'py';
      suggestions.genCommand = 'py {wrapper}';
      suggestions.mainRunCommand = 'py {main}';
      suggestions.scorerRunCommand = 'py {scorer}';
    } else {
      suggestions.pythonPath = null;
    }

    // compiled toolchain
    if (found['g++'] || found['gcc']) {
      suggestions.mainBuildCommand = 'g++ main.cpp -o {out}';
      suggestions.mainBuildEnabled = true;
      suggestions.mainRunCommand = process.platform === 'win32' ? '{out}.exe' : './{out}';
    }

    // time tool
    suggestions.timeTool = found['/usr/bin/time'] || found['time'] ? (found['/usr/bin/time'] || found['time']) : null;

    // powershell presence
    suggestions.powershell = found['powershell'] || found['pwsh'] ? (found['powershell'] || found['pwsh']) : null;

    // build markdown (日本語)
    const lines: string[] = [];
    lines.push('# NPC 環境ヘルパー');
    lines.push('');
    lines.push('## 診断（このマシンで検出された事項）');
    lines.push('');
    lines.push(`- プラットフォーム: ${process.platform}`);
    lines.push(`- node のバージョン: ${process.version}`);
    lines.push(`- 一時ディレクトリ: ${os.tmpdir()}`);
    lines.push(`- カレントディレクトリ: ${process.cwd()}`);
    lines.push('');
    lines.push('### 検出されたコマンド');
    lines.push('');
    for (const k of Object.keys(found)) {
      lines.push(`- **${k}**: ${found[k] ?? '<見つかりません>'}`);
    }
    lines.push('');
    lines.push('## 推奨ワークスペース設定');
    lines.push('');
    const settings: any = {};
    if (suggestions.pythonPath) settings['npc.pythonPath'] = suggestions.pythonPath;
    if (suggestions.genCommand) settings['npc.genCommand'] = suggestions.genCommand;
    if (suggestions.mainRunCommand) settings['npc.mainRunCommand'] = suggestions.mainRunCommand;
    if (typeof suggestions.mainBuildEnabled !== 'undefined') settings['npc.mainBuildEnabled'] = !!suggestions.mainBuildEnabled;
    if (suggestions.mainBuildCommand) settings['npc.mainBuildCommand'] = suggestions.mainBuildCommand;
    if (suggestions.scorerRunCommand) settings['npc.scorerRunCommand'] = suggestions.scorerRunCommand;
    lines.push('```json');
    lines.push(JSON.stringify(settings, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## 注意事項 / 使い方の例');
    lines.push('');
    lines.push('- `<見つかりません>` と表示されるコマンドは PATH に存在しないか、検出できませんでした。インストールするか、設定に実行ファイルのフルパスを指定してください。');
    lines.push('- 実行コマンドの例:');
    lines.push('  - Python スクリプトを実行する場合: `python3 {main}` または `py {main}`');
    lines.push('  - コンパイル済み実行ファイルを実行する場合（WSL/Linux/macOS）: `./{out}`');
    lines.push('  - コンパイル済み実行ファイルを実行する場合（Windows）: `{out}.exe`');
    lines.push('- WSL の場合は `python3` と `./{out}` を推奨します（Windows の `py` は WSL では利用できません）。');
    lines.push('- ここに示した設定は候補です。環境によってはフルパスを指定するほうが確実です。');
    lines.push('- 上記の項目がすべての実行時において必ず必要となるわけではありません。');

    const outPath = path.join(root, 'NPC_ENVIRONMENT.md');
    await writeFileAsync(outPath, lines.join('\n'), { encoding: 'utf8' });
    if (outputChannel) outputChannel.appendLine(`Environment helper written to ${outPath}`);
    try { const doc = await vscode.workspace.openTextDocument(outPath); await vscode.window.showTextDocument(doc, { preview: true }); } catch {}
  } catch (e:any) {
    if (outputChannel) outputChannel.appendLine(`Failed to generate environment helper: ${String(e)}`);
  }
}

// run a lightweight warmup to reduce first-run overhead per worker
async function runWarmup(root: string, timeoutMs: number, outputChannel?: vscode.OutputChannel) {
  try {
    const seed = `warmup_${randomBytes(4).toString('hex')}`;
    const warmCmd = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';
    if (outputChannel) outputChannel.appendLine(`Warmup: running '${warmCmd}'`);
    await runCommandCapture(warmCmd, root, null, Math.max(1000, timeoutMs), 1024, seed, outputChannel);
  } catch (e:any) {
    try { outputChannel?.appendLine(`Warmup failed: ${String(e)}`); } catch {}
  }
}

// kill helper that attempts to terminate whole process group on POSIX
function killProcGroup(p: ChildProcess | null) {
  try {
    if (!p) return;
    const pid = (p as any).pid;
    if (!pid) {
      try { p.kill(); } catch {}
      return;
    }
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    } else {
      // On Windows, ensure the whole process tree is terminated using taskkill
      try {
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
      } catch {}
    }
    try { p.kill('SIGKILL'); } catch {}
  } catch (e) {}
}

// ------------ HTML extraction helpers ------------
function extractPythonFromHtml(html: string): { code: string; seeds: string[] } {
  const $ = cheerio.load(html);

  const byId = $("#code-block-py").text();
  if (byId && String(byId).trim().length > 0) {
    const decoded = he.decode(String(byId));
    return { code: decoded.trim(), seeds: [] };
  }

  const varCodeMatch = html.match(/var\s+code\s*=\s*`([\s\S]*?)`;/);
  if (varCodeMatch && varCodeMatch[1]) {
    const decoded = he.decode(String(varCodeMatch[1]));
    return { code: decoded.trim(), seeds: [] };
  }

  const pres = $("pre");
  for (let i = 0; i < pres.length; i++) {
    const raw = $(pres[i]).text();
    const decoded = he.decode(String(raw));
    if (/^\s*(class |def |import |from )/m.test(decoded)) {
      return { code: decoded.trim(), seeds: [] };
    }
  }

  const pageText = he.decode(String($.root().text()));
  const genMatch = pageText.match(/def\s+generate[\s\S]*/);
  if (genMatch) {
    return { code: genMatch[0], seeds: [] };
  }
  throw new Error("Python generator を HTML から見つけられませんでした。");
}

// ---- URL helper ----
function expandShortNotation(input: string): string {
  const trimmed = input.trim();
  const npcMatch = trimmed.match(/^NPC0*(\d+)([A-Za-z])$/i);
  if (npcMatch) {
    const num = npcMatch[1];
    const letter = npcMatch[2].toLowerCase();
    const pad = String(num).padStart(3, "0");
    return `https://sites.google.com/view/nanyocompetitiveprogramming/%E3%82%B3%E3%83%B3%E3%83%86%E3%82%B9%E3%83%88%E4%B8%80%E8%A6%A7/contest${pad}/problems/${letter}`;
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed;
}

// ---- fetch & save generator ----
async function fetchGeneratorAndSave(urlOrShort: string, genPath: string, outputChannel?: vscode.OutputChannel): Promise<string[]> {
  const url = expandShortNotation(urlOrShort);
  const res = await fetch(url);
  if (!res.ok) {
    if (outputChannel) {
      outputChannel.appendLine(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      outputChannel.show(true);
    }
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const { code } = extractPythonFromHtml(html);
  await writeFileAsync(genPath, code, { encoding: "utf8" });
  return []; // no auto seeds
}

// ---- wrapper content for generator ----
function makeWrapperContent(seed: string, sharedVars: string[] = [], sharedFilePath?: string): string {
  const sharedVarsJson = JSON.stringify(sharedVars || []);
  const sharedFilePathJson = sharedFilePath ? JSON.stringify(sharedFilePath) : "None";
  const seedNum = Number(seed);
  const seedLiteral = Number.isFinite(seedNum) ? String(seedNum) : JSON.stringify(seed);
  return `
import sys, io, traceback, re, json, os
src = open('gen.py','r',encoding='utf-8').read()
# remove seed assignment lines to allow wrapper to set seed variable
src = re.sub(r'(?m)^\\s*seed\\s*=\\s*\\d+\\s*$', '', src)
g = {'__name__': '__main__', 'seed': ${seedLiteral}}
buf = io.StringIO()
old = sys.stdout
sys.stdout = buf
try:
    exec(src, g)
except Exception as e:
    sys.stdout = old
    traceback.print_exc(file=sys.stderr)
    sys.exit(3)
finally:
    sys.stdout = old
out = buf.getvalue()
if not out.strip():
    sys.stderr.write('Generator produced no stdout. Ensure gen.py prints the input format.\\n')
    sys.exit(2)
sys.stdout.write(out)
_shared_vars = ${sharedVarsJson}
_shared_path = ${sharedFilePathJson}
if _shared_path is not None:
    try:
        data = {}
        for _k in _shared_vars:
            if _k in g:
                try:
                    json.dumps(g[_k])
                    data[_k] = g[_k]
                except:
                    data[_k] = str(g[_k])
        d = os.path.dirname(_shared_path)
        if d and not os.path.exists(d):
            try:
                os.makedirs(d, exist_ok=True)
            except:
                pass
        with open(_shared_path, 'w', encoding='utf-8') as _f:
            json.dump(data, _f)
    except Exception:
        try:
            traceback.print_exc(file=sys.stderr)
        except:
            pass
`;
}


// Map for running processes
const runningProcesses = new Map<string, ChildProcess[]>();

async function fileExists(p: string): Promise<boolean> {
  try {
    await accessAsync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// runCommandCapture: returns exitCode, stdout, stderr, cpuTimeMs?, realTimeMs?, exitSignal?
async function runCommandCapture(runCommand: string, cwd: string, stdinStream: fs.ReadStream | null, timeoutMs: number, maxOutputBytes: number, seedSafeForTracking: string, outputChannel?: vscode.OutputChannel): Promise<{ exitCode: number | null; stdout: string; stderr: string; cpuTimeMs?: number; realTimeMs?: number; exitSignal?: string | null }> {
  if (process.platform !== "win32") {
    const timePath = "/usr/bin/time";
    const useTime = fs.existsSync(timePath);
    const cpuFile = useTime ? path.join(os.tmpdir(), `npc_cpu_${seedSafeForTracking}_${randomBytes(6).toString("hex")}.txt`) : "";
    let wrappedCmd = runCommand;
    if (useTime) {
      wrappedCmd = `${timePath} -f "%U %S" -o ${JSON.stringify(cpuFile)} sh -c ${JSON.stringify(runCommand)}`;
    } else {
      wrappedCmd = `sh -c ${JSON.stringify(runCommand)}`;
    }

    if (outputChannel) outputChannel.appendLine(`runCommandCapture (posix): wrappedCmd=${wrappedCmd} useTime=${useTime}`);
    return new Promise((resolve) => {
      const proc = spawn(wrappedCmd, { cwd, shell: true, detached: process.platform !== 'win32' });
      runningProcesses.set(seedSafeForTracking, (runningProcesses.get(seedSafeForTracking) || []).concat([proc]));

      let collected = Buffer.alloc(0);
      let stderrAll = "";
      let timedOut = false;
      if (proc.stderr) proc.stderr.on("data", d => { stderrAll += d.toString(); });
      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
          collected = Buffer.concat([collected, chunk]);
          if (collected.length > maxOutputBytes) { try { killProcGroup(proc); } catch {} }
        });
      }

      if (stdinStream && proc.stdin) {
        stdinStream.pipe(proc.stdin);
      } else if (proc.stdin) {
        try { proc.stdin.end(); } catch {}
      }

      const start = Date.now();
      const timer = setTimeout(() => { try { timedOut = true; killProcGroup(proc); } catch {} }, timeoutMs);

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        const end = Date.now();
        const realMs = end - start;
        const outStr = collected.toString("utf8");
        // prefer cpu time if available
        if (useTime) {
          try {
            const cpuText = fs.existsSync(cpuFile) ? fs.readFileSync(cpuFile, "utf8").trim() : "";
            if (cpuText) {
              const parts = cpuText.trim().split(/\s+/);
              if (parts.length >= 2) {
                const user = parseFloat(parts[0]) || 0;
                const sys = parseFloat(parts[1]) || 0;
                const cpuMs = Math.round((user + sys) * 1000);
                try { fs.unlinkSync(cpuFile); } catch {}
                const arr = runningProcesses.get(seedSafeForTracking) || [];
                runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
                if (timedOut) {
                  const stderrTimed = stderrAll + "\n*** Process killed due to timeout ***";
                  resolve({ exitCode: null, stdout: outStr, stderr: stderrTimed, cpuTimeMs: cpuMs, realTimeMs: realMs, exitSignal: signal ?? 'SIGKILL' });
                } else {
                  resolve({ exitCode: code === null ? null : code, stdout: outStr, stderr: stderrAll, cpuTimeMs: cpuMs, realTimeMs: realMs, exitSignal: signal ?? null });
                }
                return;
              }
            }
          } catch (e) {
            if (outputChannel) { outputChannel.appendLine(`Warning reading cpu file: ${String(e)}`); outputChannel.show(true); }
          }
        }
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        if (timedOut) {
          const stderrTimed = stderrAll + "\n*** Process killed due to timeout ***";
          resolve({ exitCode: null, stdout: outStr, stderr: stderrTimed, realTimeMs: realMs, exitSignal: signal ?? 'SIGKILL' });
        } else {
          resolve({ exitCode: code === null ? null : code, stdout: outStr, stderr: stderrAll, realTimeMs: realMs, exitSignal: signal ?? null });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        resolve({ exitCode: -1, stdout: collected.toString("utf8"), stderr: (err && String(err)) || "", exitSignal: null });
      });
    });
  } else {
    // Windows PowerShell wrapper approach (keep existing logic but ensure exitSignal:null is returned)
    const psPath = path.join(os.tmpdir(), `npc_win_wrapper_${seedSafeForTracking}_${randomBytes(6).toString("hex")}.ps1`);
    const psContent = `
param([string] $cmd)
# read stdin (if any)
try { $stdinData = [Console]::In.ReadToEnd() } catch { $stdinData = "" }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function EmitResult($cpu, $real, $out, $err, $exit) {
  $res = @{ cpu = $cpu; real = $real; stdout = $out; stderr = $err; exit = $exit }
  $res | ConvertTo-Json -Compress
}

function SumProcessTreeCpu($rootPid) {
  $sum = 0
  try {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $stack = New-Object System.Collections.ArrayList
    [void]$stack.Add([int]$rootPid)
    $visited = @{}
    $children = @()
    while ($stack.Count -gt 0) {
      $cur = $stack[0]
      $stack.RemoveAt(0)
      if ($visited.ContainsKey($cur)) { continue }
      $visited[$cur] = $true
      $children += $cur
      $kids = $all | Where-Object { $_.ParentProcessId -eq $cur } | Select-Object -ExpandProperty ProcessId
      foreach ($k in $kids) { [void]$stack.Add([int]$k) }
    }
    foreach ($pid in $children) {
      try {
        $gp = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($gp) { $sum += $gp.TotalProcessorTime.TotalMilliseconds }
      } catch {}
    }
  } catch {}
  return [int][math]::Round($sum)
}

# naive tokenization to get executable and args
$m = [regex] '"([^"]*)"|''([^'']*)''|([^\s]+)'
$parts = @()
foreach ($mm in $m.Matches($cmd)) {
  if ($mm.Groups[1].Success) { $parts += $mm.Groups[1].Value }
  elseif ($mm.Groups[2].Success) { $parts += $mm.Groups[2].Value }
  else { $parts += $mm.Groups[3].Value }
}

try {
  if ($parts.Count -ge 1) {
    $exe = $parts[0]
    $argList = @()
    if ($parts.Count -gt 1) { $argList = $parts[1..($parts.Count-1)] }
    $outFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "npc_out_$(New-Guid).txt")
    $errFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "npc_err_$(New-Guid).txt")

    try {
      $p = Start-Process -FilePath $exe -ArgumentList $argList -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow -PassThru
      $observed = 0
      while (-not $p.HasExited) {
        try { $val = SumProcessTreeCpu($p.Id); if ($val -gt $observed) { $observed = $val } } catch {}
        Start-Sleep -Milliseconds 50
      }
      try { $val = SumProcessTreeCpu($p.Id); if ($val -gt $observed) { $observed = $val } } catch {}
      $sw.Stop()
      $realMs = [int]$sw.ElapsedMilliseconds
      $out = ""
      $err = ""
      try { $out = Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue } catch {}
      try { $err = Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue } catch {}
      try { Remove-Item -LiteralPath $outFile -ErrorAction SilentlyContinue } catch {}
      try { Remove-Item -LiteralPath $errFile -ErrorAction SilentlyContinue } catch {}
      EmitResult $observed $realMs $out $err $p.ExitCode
      exit 0
    } catch {
      # fallback to cmd.exe invocation when Start-Process redirect not supported or fails
      $e = $_.Exception.ToString()
      # attempt cmd.exe /c
      $psi2 = New-Object System.Diagnostics.ProcessStartInfo
      $psi2.FileName = "cmd.exe"
      $psi2.Arguments = "/c " + $cmd
      $psi2.RedirectStandardOutput = $true
      $psi2.RedirectStandardError  = $true
      $psi2.RedirectStandardInput = $true
      $psi2.UseShellExecute = $false
      $psi2.CreateNoWindow = $true

      $p2 = New-Object System.Diagnostics.Process
      $p2.StartInfo = $psi2
      $p2.Start() | Out-Null
      if ($stdinData -ne $null -and $stdinData.Length -gt 0) { try { $p2.StandardInput.Write($stdinData) } catch {} }
      try { $p2.StandardInput.Close() } catch {}
      $out2 = $p2.StandardOutput.ReadToEnd()
      $err2 = $p2.StandardError.ReadToEnd()
      $p2.WaitForExit()
      $sw.Stop()
      $realMs2 = [int]$sw.ElapsedMilliseconds
      $observed2 = 0
      try {
        while (-not $p2.HasExited) {
          try { $val2 = SumProcessTreeCpu($p2.Id); if ($val2 -gt $observed2) { $observed2 = $val2 } } catch {}
          Start-Sleep -Milliseconds 50
        }
        try { $val2 = SumProcessTreeCpu($p2.Id); if ($val2 -gt $observed2) { $observed2 = $val2 } } catch {}
      } catch {}
      EmitResult $observed2 $realMs2 $out2 $err2 $p2.ExitCode
      exit 0
    }
  } else {
    # nothing to run
    $sw.Stop()
    EmitResult 0 ([int]$sw.ElapsedMilliseconds) "" "" -1
    exit 0
  }
} catch {
  $sw.Stop()
  $e = $_.Exception.ToString()
  EmitResult 0 ([int]$sw.ElapsedMilliseconds) "" $e -1
  exit 0
}
`;
    try {
      fs.writeFileSync(psPath, psContent, "utf8");
    } catch (e) {
      if (outputChannel) { outputChannel.appendLine(`Failed to write PowerShell wrapper: ${String(e)}`); outputChannel.show(true); }
      // fallback naive spawn (real time only)
      return new Promise((resolve) => {
        const proc = spawn(runCommand, { cwd, shell: true, detached: process.platform !== 'win32' });
        runningProcesses.set(seedSafeForTracking, (runningProcesses.get(seedSafeForTracking) || []).concat([proc]));
        let collected = Buffer.alloc(0);
        let stderrAll = "";
        let timedOut = false;
        if (proc.stdout) proc.stdout.on("data", (b: Buffer) => { collected = Buffer.concat([collected, b]); if (collected.length > maxOutputBytes) { try { timedOut = true; killProcGroup(proc); } catch {} } });
        if (proc.stderr) proc.stderr.on("data", (d: Buffer) => { stderrAll += d.toString(); });
        if (stdinStream && proc.stdin) { stdinStream.pipe(proc.stdin); } else if (proc.stdin) { try { proc.stdin.end(); } catch {} }
        const start = Date.now();
        const timer = setTimeout(() => { try { timedOut = true; killProcGroup(proc); } catch {} }, timeoutMs);
        proc.on("close", (code) => {
          clearTimeout(timer);
          const end = Date.now();
          const realMs = end - start;
          const arr = runningProcesses.get(seedSafeForTracking) || [];
          runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
          if (timedOut) {
            const stderrTimed = stderrAll + "\n*** Process killed due to timeout ***";
            resolve({ exitCode: null, stdout: collected.toString("utf8"), stderr: stderrTimed, realTimeMs: realMs, exitSignal: 'TIMEOUT' });
          } else {
            resolve({ exitCode: code === null ? null : code, stdout: collected.toString("utf8"), stderr: stderrAll, realTimeMs: realMs, exitSignal: null });
          }
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          const arr = runningProcesses.get(seedSafeForTracking) || [];
          runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
          resolve({ exitCode: -1, stdout: collected.toString("utf8"), stderr: (err && String(err)) || "", exitSignal: null });
        });
      });
    }

    if (outputChannel) outputChannel.appendLine(`runCommandCapture (win): psPath=${psPath} invoking powershell with cmd=${runCommand}`);
    return new Promise((resolve) => {
      const proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath, runCommand], { cwd, stdio: ["pipe","pipe","pipe"], detached: process.platform !== 'win32' });
      runningProcesses.set(seedSafeForTracking, (runningProcesses.get(seedSafeForTracking) || []).concat([proc]));

      let collected = Buffer.alloc(0);
      let stderrAll = "";
      let timedOut = false;
      if (proc.stdout) proc.stdout.on("data", (b: Buffer) => { collected = Buffer.concat([collected, b]); if (collected.length > maxOutputBytes) try { killProcGroup(proc); } catch {} });
      if (proc.stderr) proc.stderr.on("data", (d: Buffer) => { stderrAll += d.toString(); });

      if (stdinStream && proc.stdin) {
        stdinStream.pipe(proc.stdin);
      } else if (proc.stdin) {
        try { proc.stdin.end(); } catch {}
      }

      const timer = setTimeout(() => { try { timedOut = true; killProcGroup(proc); } catch {} }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        const txt = collected.toString("utf8").trim();
        try {
          if (txt) {
            const obj = JSON.parse(txt);
            const cpu = typeof obj.cpu === "number" ? obj.cpu : undefined;
            const real = typeof obj.real === "number" ? obj.real : undefined;
            const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
            const stderrFrom = typeof obj.stderr === "string" ? obj.stderr : "";
            const stderrAllCombined = stderrAll + (stderrFrom ? ("\n" + stderrFrom) : "");
            try { fs.unlinkSync(psPath); } catch {}
            if (timedOut) {
              const stderrTimed = stderrAllCombined + "\n*** Process killed due to timeout ***";
              resolve({ exitCode: null, stdout: stdout, stderr: stderrTimed, cpuTimeMs: cpu, realTimeMs: real, exitSignal: 'TIMEOUT' });
            } else {
              resolve({ exitCode: obj.exit ?? (code === null ? null : code), stdout: stdout, stderr: stderrAllCombined, cpuTimeMs: cpu, realTimeMs: real, exitSignal: null });
            }
            return;
          } else {
            try { fs.unlinkSync(psPath); } catch {}
            if (timedOut) {
              const stderrTimed = stderrAll + "\n*** Process killed due to timeout ***";
              resolve({ exitCode: null, stdout: "", stderr: stderrTimed, exitSignal: 'TIMEOUT' });
            } else {
              resolve({ exitCode: code === null ? null : code, stdout: "", stderr: stderrAll, exitSignal: null });
            }
            return;
          }
        } catch (e) {
          if (outputChannel) { outputChannel.appendLine(`Failed to parse PowerShell wrapper output: ${String(e)}`); outputChannel.show(true); }
          try { fs.unlinkSync(psPath); } catch {}
          if (timedOut) {
            const stderrTimed = stderrAll + "\n*** Process killed due to timeout ***";
            resolve({ exitCode: null, stdout: txt, stderr: stderrTimed, exitSignal: 'TIMEOUT' });
          } else {
            resolve({ exitCode: code === null ? null : code, stdout: txt, stderr: stderrAll, exitSignal: null });
          }
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        try { fs.unlinkSync(psPath); } catch {}
        resolve({ exitCode: -1, stdout: collected.toString("utf8"), stderr: (err && String(err)) || "", exitSignal: null });
      });
    });
  }
}


// ---- runSingleSeed: generator -> main ----
async function runSingleSeed(seed: string, cfg: any, root: string, outputDir: string, outputChannel: vscode.OutputChannel, timeoutMsOverride?: number): Promise<{ seed: string; ok: boolean; exitCode?: number; err?: string; stdout?: string; mainTimeMs?: number; realTimeMs?: number; stage?: string; parsedScore?: number }> {
  const mainTimeoutMs = timeoutMsOverride ?? (Number(cfg.timeoutMsMain) || defaultCfg().timeoutMsMain);
  const genTimeoutMs = Number(cfg.timeoutMsGen) || defaultCfg().timeoutMsGen;
  const maxOutputBytes = Number(cfg.maxOutputBytes) || defaultCfg().maxOutputBytes;

  const wrapperName = `__npc_wrapper_${safeFilenamePart(seed)}_${randomBytes(6).toString("hex")}.py`;
  const wrapperPath = path.join(os.tmpdir(), wrapperName);
  const seedSafe = safeFilenamePart(seed);

  runningProcesses.set(seedSafe, []);
  const outputsDir = path.join(outputDir, "outputs");
  if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
  const sharedFilePath = path.join(outputsDir, `shared_${seedSafe}.json`);
  const sharedVars: string[] = (cfg.sharedVars && String(cfg.sharedVars).trim().length > 0) ? String(cfg.sharedVars).split(/\s*,\s*/).map((s:string)=>s.trim()).filter(Boolean) : [];

  try {
    await writeFileAsync(wrapperPath, makeWrapperContent(seed, sharedVars, sharedVars.length > 0 ? sharedFilePath : undefined), { encoding: "utf8" });

    // run generator
    const genCommandTemplate = cfg.genCommand || defaultCfg().genCommand;
    const genCommand = String(genCommandTemplate).replace(/\{wrapper\}/g, `"${wrapperPath}"`).replace(/\{out\}/g, `"${cfg.mainExec || defaultCfg().mainExec}"`);
    if (outputChannel) outputChannel.appendLine(`runSingleSeed: gen wrapperPath=${wrapperPath} genCommandTemplate=${genCommandTemplate}`);
    const genStdoutChunks: Buffer[] = [];
    let genStderr = "";
    let genExitCode: number | null = null;
    const genProc = spawn(genCommand, { cwd: root, shell: true, detached: process.platform !== 'win32' });
    runningProcesses.get(seedSafe)?.push(genProc);
    genProc.stdout?.on("data", (b: Buffer) => genStdoutChunks.push(b));
    genProc.stderr?.on("data", (d: Buffer) => { genStderr += d.toString(); });

    if (outputChannel) outputChannel.appendLine(`Spawning generator: ${genCommand}`);
    const genPromise = new Promise<void>((resolve) => {
      const genTimeout = setTimeout(() => { try { killProcGroup(genProc); } catch {} genExitCode = -1; resolve(); }, genTimeoutMs);
      genProc.on("close", (code) => { clearTimeout(genTimeout); genExitCode = code ?? 0; resolve(); });
      genProc.on("error", () => { clearTimeout(genTimeout); genExitCode = -1; resolve(); });
    });
    await genPromise;
    const genOutput = Buffer.concat(genStdoutChunks).toString("utf8");

    const inputsDir = path.join(outputDir, "inputs");
    if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });

    try { fs.writeFileSync(path.join(outputsDir, `out_gen_${seedSafe}.txt`), genOutput + "\n", "utf8"); } catch {}

    if (genExitCode !== 0) {
      const msg = `Generator failed (exit ${genExitCode}). stderr:\n${genStderr}`;
      return { seed, ok: false, exitCode: typeof genExitCode === "number" ? genExitCode : undefined, err: msg, stdout: genOutput, stage: 'generate' };
    }
    if (!genOutput || !genOutput.trim()) {
      const msg = `Generator produced no stdout. stderr:\n${genStderr}`;
      return { seed, ok: false, err: msg, stdout: genOutput, stage: 'generate' };
    }

    // write input file
    const inFile = path.join(inputsDir, `in_${seedSafe}.txt`);
    try { fs.writeFileSync(inFile, genOutput, "utf8"); } catch (e:any) { return { seed, ok: false, err: `Failed to write generator input file: ${String(e)}`, stage: 'write_input' }; }

    // run main
    const mainRunTemplate = cfg.mainRunCommand || defaultCfg().mainRunCommand;
    const mainFilename = cfg.mainFilename || defaultCfg().mainFilename;
    const mainExec = cfg.mainExec || defaultCfg().mainExec;
    let runCommand = String(mainRunTemplate)
      .replace(/\{main\}/g, `${mainFilename}`)
      .replace(/\{exe\}/g, `${mainExec}`)
      .replace(/\{out\}/g, `${mainExec}`);

    // Keep quoting behavior simple — wrapper handles shell on Windows
    if (!/^\s*["']/.test(runCommand) && runCommand.includes(" ")) {
      // leave as is; shell=true will handle it
    }

    let rs: fs.ReadStream | null = null;
    try { rs = fs.createReadStream(inFile); } catch { rs = null; }

    const runResult = await runCommandCapture(runCommand, root, rs, mainTimeoutMs, maxOutputBytes, seedSafe, outputChannel);
    const outString = runResult.stdout ?? "";
    const code = runResult.exitCode ?? -1;
    const cpuMs = (typeof runResult.cpuTimeMs === 'number' && !isNaN(runResult.cpuTimeMs)) ? runResult.cpuTimeMs : 0;
    const realMs = runResult.realTimeMs;
    const exitSignal = runResult.exitSignal ?? null;
    const stderrAll = runResult.stderr ?? "";

    if (outString && outString.length > 0) {
      try { fs.writeFileSync(path.join(outputsDir, `out_${seedSafe}.txt`), outString, "utf8"); } catch {}
    }

    // detect timeout: runCommandCapture returns exitCode === null when killed by our timeout
    if (runResult.exitCode === null || /Process killed due to timeout|\*\*\* Process killed due to timeout \*\*\*/i.test(runResult.stderr || "") || runResult.exitSignal === 'TIMEOUT' || runResult.exitSignal === 'SIGKILL') {
      return { seed, ok: false, err: 'TLE', stage: 'run', parsedScore: -1 };
    }

    if (code !== 0) {
      // RE判定: 終了シグナルが渡っている or stderr に典型的なトレースや segmentation fault が含まれる場合
      const stderrForDetect = String(stderrAll || "");
      const rePattern = /Traceback \(most recent call last\)|Segmentation fault|Segfault|Unhandled exception|RuntimeError|exception/i;
      const isRE = !!exitSignal || rePattern.test(stderrForDetect);
      const msg = isRE ? `RE` : `Main exited with code ${code}. stderr:\n${stderrAll}`;
      return { seed, ok: false, exitCode: code ?? undefined, err: msg, stdout: outString, mainTimeMs: cpuMs, realTimeMs: realMs, stage: 'run' };
    }

    return { seed, ok: true, exitCode: code ?? undefined, stdout: outString, mainTimeMs: cpuMs, realTimeMs: realMs };
  } finally {
    try { if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath); } catch {}
    runningProcesses.delete(seedSafe);
  }
}

// ---- runScorer: runs scorer with NPC_SHARED_FILE env var; parse numeric score; -1 => WA ----
async function runScorer(seed: string, cfg: any, root: string, outputDir: string, outputChannel: vscode.OutputChannel, timeoutMsOverride?: number): Promise<{ ok: boolean; exitCode?: number; err?: string; stdout?: string; parsedScore?: number; stage?: string }> {
  const timeoutMs = timeoutMsOverride ?? (Number(cfg.timeoutMsScorer) || defaultCfg().timeoutMsScorer);
  const maxOutputBytes = Number(cfg.maxOutputBytes) || defaultCfg().maxOutputBytes;
  const seedSafe = safeFilenamePart(seed);
  const outputsDir = path.join(outputDir, "outputs");
  const mainOutFile = path.join(outputsDir, `out_${seedSafe}.txt`);
  if (!fs.existsSync(mainOutFile)) {
    return { ok: false, err: "Main output file not found for scorer." };
  }

  const scorerRunTemplate = cfg.scorerRunCommand || defaultCfg().scorerRunCommand;
  const scorerFilename = cfg.scorerFilename || defaultCfg().scorerFilename;
  const scorerExec = cfg.scorerExec || defaultCfg().scorerExec;
  let runCommand = String(scorerRunTemplate)
    .replace(/\{scorer\}/g, `${scorerFilename}`)
    .replace(/\{exe\}/g, `${scorerExec}`)
    .replace(/\{out\}/g, `${scorerExec}`);

  runningProcesses.set(seedSafe, []);
  try {
    const proc = spawn(runCommand, { cwd: root, shell: true, env: { ...process.env, NPC_SHARED_FILE: path.join(outputsDir, `shared_${seedSafe}.json`) }, detached: process.platform !== 'win32' });
    runningProcesses.get(seedSafe)?.push(proc);

    let collected = Buffer.alloc(0);
    let stderrAll = "";
    let exceeded = false;
    let timedOut = false;
    if (proc.stderr) proc.stderr.on("data", d => { stderrAll += d.toString(); });
        if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        collected = Buffer.concat([collected, chunk]);
        if (collected.length > maxOutputBytes) { exceeded = true; try { killProcGroup(proc); } catch {} }
      });
    }

    const rs = fs.createReadStream(mainOutFile);
    rs.pipe(proc.stdin);

    const timeout = setTimeout(() => { try { timedOut = true; killProcGroup(proc); } catch {} }, timeoutMs);
    const code = await new Promise<number | null>((resolve) => {
      proc.on("close", (c) => { clearTimeout(timeout); resolve(c ?? 0); });
      proc.on("error", () => { clearTimeout(timeout); resolve(-1); });
    });
    const outString = collected.toString("utf8");

    if (exceeded) {
      return { ok: false, exitCode: code ?? undefined, err: "Scorer output exceeded limit", stdout: outString, stage: 'scorer' };
    }
    if (timedOut) {
      return { ok: false, exitCode: code ?? undefined, err: 'TLE', stdout: outString, parsedScore: -1, stage: 'scorer' };
    }
    if (code !== 0) {
      return { ok: false, exitCode: code ?? undefined, err: `Scorer exited with code ${code}. stderr:\n${stderrAll}`, stdout: outString, stage: 'scorer' };
    }

    // parse numeric score (first number)
    let parsed: number | undefined = undefined;
    const sTrim = outString.trim();
    if (sTrim.length > 0) {
      const m = sTrim.match(/-?\d+(\.\d+)?/);
      if (m) parsed = Number(m[0]);
    }

    if (typeof parsed === "number" && parsed === -1) {
      return { ok: false, exitCode: code ?? undefined, err: "Scorer returned -1 (WA)", stdout: outString, parsedScore: parsed, stage: 'scorer' };
    }

    return { ok: true, exitCode: code ?? undefined, stdout: outString, parsedScore: parsed };
  } finally {
    runningProcesses.delete(seedSafe);
  }
}

// ---- kill helpers ----
function killAllRunning() {
  for (const [seed, procs] of Array.from(runningProcesses.entries())) {
    for (const p of procs) {
      try { killProcGroup(p); } catch {}
    }
  }
  runningProcesses.clear();
}

// clear files inside a directory (non-recursive)
function clearDirFiles(dir: string) {
  try {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir);
    for (const it of items) {
      const p = path.join(dir, it);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() || st.isSymbolicLink()) {
          try { fs.unlinkSync(p); } catch {}
        }
      } catch {}
    }
  } catch (e) {}
}

// ---- Summary writer helper with aggregates ----
function writeSummaryWithStats(outdir: string, seeds: string[], results: any[], threads: number, root: string, outputChannel: vscode.OutputChannel, title: string = "NPC Run Summary", execInfo?: any) {
  const summaryMdPath = path.join(outdir, "summary.md");
  const mdLines: string[] = [];
  mdLines.push(`# ${title}`);
  mdLines.push("");
  mdLines.push(`**Workspace:** ${root}`);
  mdLines.push(`**Date:** ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  mdLines.push(`**Threads used:** ${threads}`);
  mdLines.push("");
  mdLines.push("| # | seed | status | err | score | maintime(ms) | realtime(ms) |");
  mdLines.push("|---:|:---|:---:|:---|:---:|---:|---:|");

  // collect values for aggregates
  const scores: number[] = [];
  const cpuTimes: number[] = [];
  const realTimes: number[] = [];
  let scorerPresent = false;
  let acScorerCount = 0;
  let okMainCount = 0;

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    const r = results[i];
    if (!r) {
      mdLines.push(`| ${i+1} | ${s} | NO_RESULT |  |  |  |  |`);
      continue;
    }

    let status = "";
    let errStr = "";
    let scoreVal: number | null = null;
    let cpuVal: number | null = null;
    let realVal: number | null = null;

    if (typeof r.main_ok !== "undefined" || typeof r.scorer_ok !== "undefined") {
      // heuristic-style / judge-style result object
      const main_ok = r.main_ok === true;
      const scorer_ok = r.scorer_ok === true ? true : (r.scorer_ok === false ? false : undefined);

      // Check for RE first
      if (!main_ok && r.main_err && (/^RE$/i.test(String(r.main_err)) || /\bRE\b/.test(String(r.main_err)))) {
        status = "RE";
      } else if (!main_ok) {
        if (r.main_err && (/kill|timed|Time|timeout|TLE/i.test(r.main_err) || /Output exceeded limit/.test(r.main_err))) status = "TLE/ERR";
        else status = "MAIN_FAIL";
      } else {
        if (scorer_ok === true) status = "AC";
        else if (scorer_ok === false) status = "WA";
        else status = "NO_SCORER";
      }

      errStr = (r.scorer_err ? String(r.scorer_err) : (r.main_err ? String(r.main_err) : "")).replace(/\|/g,'\\|').replace(/\n/g,' ');
      if (typeof r.scorer_score === "number") { scoreVal = r.scorer_score; scorerPresent = true; }
      else if (typeof r.scorer_score === "string" && r.scorer_score.trim() !== "" && !isNaN(Number(r.scorer_score))) { scoreVal = Number(r.scorer_score); scorerPresent = true; }
      if (typeof r.mainTimeMs === "number") cpuVal = r.mainTimeMs;
      if (typeof r.realTimeMs === "number") realVal = r.realTimeMs;

      if (scorer_ok === true) acScorerCount++;
      if (main_ok) okMainCount++;
    } else {
      // simple runWithGenerators result
      const ok = r.ok === true;
      if (!ok) {
        if (r.err && (/kill|timed|Time|timeout|TLE/i.test(r.err) || /Output exceeded limit/.test(r.err))) status = "TLE/ERR";
        else if (r.err && (/^RE$/i.test(String(r.err)) || /\bRE\b/.test(String(r.err)))) status = "RE";
        else status = "MAIN_FAIL";
      } else {
        status = "OK";
      }
      errStr = r.err ? String(r.err).replace(/\|/g,'\\|').replace(/\n/g,' ') : "";
      if (typeof r.scorer_score === "number") { scoreVal = r.scorer_score; scorerPresent = true; }
      if (typeof r.parsedScore === "number") { scoreVal = r.parsedScore; scorerPresent = true; }
      if (typeof r.mainTimeMs === "number") cpuVal = r.mainTimeMs;
      if (typeof r.realTimeMs === "number") realVal = r.realTimeMs;

      if (ok) okMainCount++;
    }

    if (typeof scoreVal === "number" && Number.isFinite(scoreVal)) scores.push(scoreVal);
    if (typeof cpuVal === "number" && Number.isFinite(cpuVal)) cpuTimes.push(cpuVal);
    if (typeof realVal === "number" && Number.isFinite(realVal)) realTimes.push(realVal);

    const scoreStr = (typeof scoreVal === "number") ? String(scoreVal) : "";
    const timeStr = (typeof cpuVal === "number" && Number.isFinite(cpuVal)) ? String(cpuVal) : "0";
    const realStr = (typeof realVal === "number" && Number.isFinite(realVal)) ? String(realVal) : "0";

    mdLines.push(`| ${i+1} | ${s} | ${status} | ${errStr} | ${scoreStr} | ${timeStr} | ${realStr} |`);
  }

  // aggregates
  const totalSeeds = seeds.length;
  const sumScore = scores.reduce((a,b) => a + b, 0);
  const avgScore = scores.length > 0 ? (sumScore / scores.length) : null;
  const maxCpu = cpuTimes.length > 0 ? Math.max(...cpuTimes) : null;
  const maxReal = realTimes.length > 0 ? Math.max(...realTimes) : null;

  mdLines.push("");
  mdLines.push("## Aggregates");
  mdLines.push("");
  mdLines.push(`- **平均スコア (平均 over scored seeds):** ${avgScore !== null ? avgScore.toFixed(3) : "-"}`);
  mdLines.push(`- **総合スコア (sum over scored seeds):** ${scores.length > 0 ? String(sumScore) : "-"}`);
  mdLines.push(`- **最大 maintime (ms):** ${maxCpu !== null ? String(maxCpu) : "-"}`);
  mdLines.push(`- **最大 realtime (ms):** ${maxReal !== null ? String(maxReal) : "-"}`);

  let acCountStr = "-";
  if (scorerPresent) {
    acCountStr = `${acScorerCount}/${totalSeeds}`;
  } else {
    acCountStr = `${okMainCount}/${totalSeeds}`;
  }
  mdLines.push(`- **AC数 (A/B):** ${acCountStr}`);

  // include commands/settings used in this run if provided
  if (execInfo && typeof execInfo === 'object') {
    mdLines.push("");
    mdLines.push("## Commands and Settings Used");
    mdLines.push("");
    for (const k of Object.keys(execInfo)) {
      try {
        const v = execInfo[k];
        if (v === null || typeof v === 'undefined') continue;
        if (typeof v === 'object') {
          mdLines.push(`- **${k}:** ${JSON.stringify(v)}`);
        } else {
          mdLines.push(`- **${k}:** ${String(v)}`);
        }
      } catch (e) {}
    }
  }

  try {
    fs.writeFileSync(summaryMdPath, mdLines.join("\n"), "utf8");
    outputChannel.appendLine(`Summary written to ${summaryMdPath}`);
  } catch (e:any) {
    outputChannel.appendLine(`Failed to write summary: ${String(e)}`);
  }
}

// ---- activation / commands ----
export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("NPC Runner");
  context.subscriptions.push(outputChannel);
  // log environment diagnostics to help debug WSL / platform issues
  try { logEnvironment(outputChannel); } catch {}

  const fetchCommand = vscode.commands.registerCommand("npc.fetchGenerator", async () => {
    try {
      const root = ensureWorkspace();
      const config = getConfig();
      const genFilename = config.get("genFilename") || defaultCfg().genFilename;
      const input = await vscode.window.showInputBox({ prompt: "Enter NPC short (e.g. NPC004B) or full URL" });
      if (!input) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching generator..." }, async (progress) => {
        progress.report({ message: "Downloading..." });
        try {
          await fetchGeneratorAndSave(input, path.join(root, String(genFilename)), outputChannel);
          outputChannel.appendLine(`Saved ${genFilename} to workspace.`);
          vscode.window.showInformationMessage(`gen.py saved. (Seed auto-extraction disabled — please enter seeds manually when running.)`);
          const doc = await vscode.workspace.openTextDocument(path.join(root, String(genFilename)));
          await vscode.window.showTextDocument(doc);
        } catch (e: any) {
          outputChannel.appendLine(`Error fetching generator: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
        }
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  const runCommand = vscode.commands.registerCommand("npc.runWithGenerators", async () => {
    try {
      const root = ensureWorkspace();
      const config = getConfig();
      const cfg = {
        pythonPath: config.get("pythonPath") || defaultCfg().pythonPath,
        genFilename: config.get("genFilename") || defaultCfg().genFilename,
        mainFilename: config.get("mainFilename") || defaultCfg().mainFilename,
        timeoutMsGen: config.get("timeoutMsGen") ?? defaultCfg().timeoutMsGen,
        timeoutMsMain: config.get("timeoutMsMain") ?? defaultCfg().timeoutMsMain,
        timeoutMsScorer: config.get("timeoutMsScorer") ?? defaultCfg().timeoutMsScorer,
        maxOutputBytes: config.get("maxOutputBytes") ?? defaultCfg().maxOutputBytes,
        outputDir: config.get("outputDir") || defaultCfg().outputDir,
        threads: config.get("threads") ?? defaultCfg().threads,
        genCommand: config.get("genCommand") || defaultCfg().genCommand,
        mainBuildCommand: config.get("mainBuildCommand") || defaultCfg().mainBuildCommand,
        mainBuildEnabled: config.get("mainBuildEnabled") ?? defaultCfg().mainBuildEnabled,
        mainRunCommand: config.get("mainRunCommand") || defaultCfg().mainRunCommand,
        mainExec: config.get("mainExec") || defaultCfg().mainExec,
        scorerFilename: config.get("scorerFilename") || defaultCfg().scorerFilename,
        scorerRunCommand: config.get("scorerRunCommand") || defaultCfg().scorerRunCommand,
        scorerExec: config.get("scorerExec") || defaultCfg().scorerExec,
        scorerBuildCommand: config.get("scorerBuildCommand") || defaultCfg().scorerBuildCommand,
        scorerBuildEnabled: config.get("scorerBuildEnabled") ?? defaultCfg().scorerBuildEnabled,
        sharedVars: config.get("sharedVars") ?? defaultCfg().sharedVars
        // judge related settings (used to treat TLEs like judge does)
      ,  judgeTimeLimitMs: config.get("judgeTimeLimitMs") ?? defaultCfg().judgeTimeLimitMs
      ,  judgeRetries: config.get("judgeRetries") ?? defaultCfg().judgeRetries
      ,  judgeRealTimeoutFactor: config.get("judgeRealTimeoutFactor") ?? defaultCfg().judgeRealTimeoutFactor
      };

      const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL to fetch generator (leave empty to use existing gen.py)" });
      const genPath = path.join(root, String(cfg.genFilename));
      if (urlOrShort) {
        try {
          await fetchGeneratorAndSave(urlOrShort, genPath, outputChannel);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
          return;
        }
      } else {
        if (!(await fileExists(genPath))) {
          vscode.window.showErrorMessage("No gen.py in workspace. Provide a URL or create gen.py first.");
          return;
        }
      }

      const manual = await vscode.window.showInputBox({ prompt: "Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
      if (!manual) return;
      const seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
      if (seeds.length === 0) {
        vscode.window.showErrorMessage("No seeds provided.");
        return;
      }

      outputChannel.appendLine(`Running seeds: ${seeds.join(", ")}`);

      const outdir = path.resolve(root, String(cfg.outputDir ?? defaultCfg().outputDir));
      if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
      const inputsDir = path.join(outdir, "inputs");
      const outputsDir = path.join(outdir, "outputs");
      if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
      // clear previous run files to avoid confusion across runs
      try { clearDirFiles(inputsDir); } catch {}
      try { clearDirFiles(outputsDir); } catch {}
      // clear previous run files to avoid confusion across runs
      try { clearDirFiles(inputsDir); } catch {}
      try { clearDirFiles(outputsDir); } catch {}
      // clear previous run files to avoid confusion across runs
      try { clearDirFiles(inputsDir); } catch {}
      try { clearDirFiles(outputsDir); } catch {}

      const results: Array<any> = [];

      let threads = Number(cfg.threads) || 0;
      if (threads <= 0) threads = getPhysicalCoreCount();

      outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);

      // Build main if specified AND enabled
      if (cfg.mainBuildEnabled && cfg.mainBuildCommand && String(cfg.mainBuildCommand).trim().length > 0) {
        outputChannel.appendLine(`Running build: ${cfg.mainBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.mainBuildCommand).replace(/\{out\}/g, `${cfg.mainExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true, detached: process.platform !== 'win32' });
          runningProcesses.set("build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Build failed: ${String(e)}`);
          return;
        }
      } else {
        outputChannel.appendLine(`Build skipped (mainBuildEnabled=${cfg.mainBuildEnabled})`);
      }

      let cancelled = false;

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running tests with generator(s) — threads: ${threads}`, cancellable: true }, async (progress, token) => {
        const total = seeds.length;
        let completed = 0;
        const queue: Promise<void>[] = [];
        let idx = 0;

        token.onCancellationRequested(() => {
          cancelled = true;
          outputChannel.appendLine("Cancellation requested — killing running processes...");
          killAllRunning();
        });

        const worker = async () => {
          // per-worker warmup to reduce first-run overhead
          try { await runWarmup(root, Math.max(1000, Number(cfg.timeoutMsGen) || defaultCfg().timeoutMsGen), outputChannel); } catch {}
          while (true) {
            if (cancelled) return;
            const myIndex = idx;
            idx++;
            if (myIndex >= seeds.length) return;
            const s = seeds[myIndex];
            progress.report({ message: `Running seed ${s} (${myIndex + 1}/${total})`, increment: (100 / total) });
            outputChannel.appendLine(`=== Seed ${s} ===`);
            try {
              // Retry logic to mimic judge behavior: try up to cfg.judgeRetries
              const attempts = Math.max(1, Number(cfg.judgeRetries) || 1);
              const timeLimitMs = Number(cfg.judgeTimeLimitMs) || defaultCfg().judgeTimeLimitMs;
              const realTimeoutFactor = Number(cfg.judgeRealTimeoutFactor) || defaultCfg().judgeRealTimeoutFactor;
              let acceptedRun: any = null;
              let lastRun: any = null;
              const attemptsList: any[] = [];
              for (let attempt = 1; attempt <= attempts; attempt++) {
                if (cancelled) break;
                outputChannel.appendLine(`Seed ${s}: attempt ${attempt}/${attempts}`);
                const timeoutForThisRun = Math.max(Number(cfg.timeoutMsMain) || defaultCfg().timeoutMsMain, timeLimitMs * realTimeoutFactor + 1000);
                const r = await runSingleSeed(s, cfg, root, outdir, outputChannel, timeoutForThisRun);
                lastRun = r;
                attemptsList.push(r);
                const measuredMs = (typeof r.mainTimeMs === "number" && !isNaN(r.mainTimeMs)) ? r.mainTimeMs : r.realTimeMs;
                const measuredStr = typeof measuredMs === "number" ? `${measuredMs} ms` : "N/A";
                outputChannel.appendLine(`Seed ${s}: attempt ${attempt} result: ok=${r.ok} measured=${measuredStr} stage=${r.stage ?? 'unknown'} err=${r.err ?? ""}`);
                if (r.ok && typeof measuredMs === "number" && measuredMs <= timeLimitMs) {
                  acceptedRun = r;
                  outputChannel.appendLine(`Seed ${s}: accepted on attempt ${attempt} (measured ${measuredMs} ms <= ${timeLimitMs} ms)`);
                  break;
                }
              }

              const resObj: any = {
                seed: s,
                main_ok: false,
                main_exitCode: null,
                main_err: null,
                main_stdout: null,
                mainTimeMs: null,
                realTimeMs: null,
                scorer_ok: null,
                scorer_exitCode: null,
                scorer_err: null,
                scorer_stdout: null,
                scorer_score: null
              };

              if (acceptedRun) {
                resObj.main_ok = true;
                resObj.main_exitCode = acceptedRun.exitCode;
                resObj.main_err = acceptedRun.err;
                resObj.main_stdout = acceptedRun.stdout;
                resObj.mainTimeMs = acceptedRun.mainTimeMs;
                resObj.realTimeMs = acceptedRun.realTimeMs;
                outputChannel.appendLine(`Seed ${s}: OK (cpu=${resObj.mainTimeMs ?? "N/A"} ms realtime=${resObj.realTimeMs ?? "N/A"} ms) — running scorer...`);
                if (await fileExists(path.join(root, String(cfg.scorerFilename)))) {
                  try {
                    const sc = await runScorer(s, cfg, root, outdir, outputChannel);
                    resObj.scorer_ok = sc.ok;
                    resObj.scorer_exitCode = sc.exitCode;
                    resObj.scorer_err = sc.err;
                    resObj.scorer_stdout = sc.stdout;
                    resObj.scorer_score = sc.parsedScore ?? null;
                    if (sc.ok) {
                      outputChannel.appendLine(`Seed ${s}: scorer OK (score: ${sc.parsedScore ?? "N/A"})`);
                    } else {
                      outputChannel.appendLine(`Seed ${s}: scorer FAILED - ${sc.err}`);
                    }
                  } catch (e:any) {
                    resObj.scorer_ok = false;
                    resObj.scorer_err = String(e);
                    outputChannel.appendLine(`Seed ${s}: scorer exception - ${String(e)}`);
                  }
                } else {
                  outputChannel.appendLine(`Seed ${s}: scorer not found — skipping scorer.`);
                }
              } else {
                // no accepted run within retries -> mark TLE and set score -1
                if (lastRun) {
                  let fastestMs: number | null = null;
                  let fastestReal: number | null = null;
                  for (const a of attemptsList) {
                    const m = (typeof a.mainTimeMs === "number" && !isNaN(a.mainTimeMs)) ? a.mainTimeMs : a.realTimeMs;
                    if (typeof m === "number") {
                      if (fastestMs === null || m < fastestMs) {
                        fastestMs = m;
                        fastestReal = a.realTimeMs ?? null;
                      }
                    }
                  }
                  resObj.main_ok = false;
                  resObj.main_exitCode = lastRun.exitCode;
                  resObj.main_err = lastRun.err || 'TLE';
                  resObj.main_stdout = lastRun.stdout;
                  resObj.mainTimeMs = fastestMs !== null ? fastestMs : lastRun.mainTimeMs;
                  resObj.realTimeMs = fastestReal !== null ? fastestReal : lastRun.realTimeMs;
                } else {
                  resObj.main_ok = false;
                  resObj.main_err = 'TLE';
                }
                resObj.scorer_score = -1;
                outputChannel.appendLine(`Seed ${s}: all attempts exceeded time limit -> marked TLE`);
              }

              results[myIndex] = resObj;
            } catch (e:any) {
              outputChannel.appendLine(`Seed ${s}: Exception - ${String(e)}`);
              results[myIndex] = { seed: s, ok: false, err: String(e) };
            }
            completed++;
            progress.report({ message: `Completed ${completed}/${total}`, increment: (100 / total) });
          }
        };

        for (let i = 0; i < threads; i++) {
          queue.push(worker());
        }
        await Promise.all(queue);
      });

      // combine outputs
      try {
        const combinedPath = path.join(outdir, "out.txt");
        const parts: string[] = [];
        for (let i = 0; i < seeds.length; i++) {
          const s = seeds[i];
          const sf = safeFilenamePart(s);
          const fn = path.join(outdir, "outputs", `out_${sf}.txt`);
          if (fs.existsSync(fn)) parts.push(fs.readFileSync(fn, "utf8"));
        }
        fs.writeFileSync(combinedPath, parts.join("\n"), "utf8");
        vscode.window.showInformationMessage(`Run completed. Combined output written to ${combinedPath}`);
        outputChannel.appendLine(`Combined output written to ${combinedPath}`);
      } catch (e: any) {
        outputChannel.appendLine(`Failed to combine outputs: ${String(e)}`);
      }

      // write summary with stats
      try {
        const execInfo: any = {
          genCommand: cfg.genCommand,
          mainRunCommand: cfg.mainRunCommand,
          mainBuildEnabled: cfg.mainBuildEnabled,
        };
        if (cfg.mainBuildEnabled) execInfo.mainBuildCommand = cfg.mainBuildCommand;
        writeSummaryWithStats(outdir, seeds, results, threads, root, outputChannel, "NPC Run Summary", execInfo);
        try {
          const doc = await vscode.workspace.openTextDocument(path.join(outdir, "summary.md"));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {}
      } catch (e:any) {
        outputChannel.appendLine(`Failed to write summary: ${String(e)}`);
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  // heuristic command (gen -> main -> scorer)
  const runHeuristicCommand = vscode.commands.registerCommand("npc.runHeuristic", async () => {
    try {
      const root = ensureWorkspace();
      const config = getConfig();
      const cfg = {
        pythonPath: config.get("pythonPath") || defaultCfg().pythonPath,
        genFilename: config.get("genFilename") || defaultCfg().genFilename,
        mainFilename: config.get("mainFilename") || defaultCfg().mainFilename,
        timeoutMsGen: config.get("timeoutMsGen") ?? defaultCfg().timeoutMsGen,
        timeoutMsMain: config.get("timeoutMsMain") ?? defaultCfg().timeoutMsMain,
        timeoutMsScorer: config.get("timeoutMsScorer") ?? defaultCfg().timeoutMsScorer,
        maxOutputBytes: config.get("maxOutputBytes") ?? defaultCfg().maxOutputBytes,
        outputDir: config.get("outputDir") || defaultCfg().outputDir,
        threads: config.get("threads") ?? defaultCfg().threads,
        genCommand: config.get("genCommand") || defaultCfg().genCommand,
        mainBuildCommand: config.get("mainBuildCommand") || defaultCfg().mainBuildCommand,
        mainBuildEnabled: config.get("mainBuildEnabled") ?? defaultCfg().mainBuildEnabled,
        mainRunCommand: config.get("mainRunCommand") || defaultCfg().mainRunCommand,
        mainExec: config.get("mainExec") || defaultCfg().mainExec,
        scorerFilename: config.get("scorerFilename") || defaultCfg().scorerFilename,
        scorerRunCommand: config.get("scorerRunCommand") || defaultCfg().scorerRunCommand,
        scorerExec: config.get("scorerExec") || defaultCfg().scorerExec,
        scorerBuildCommand: config.get("scorerBuildCommand") || defaultCfg().scorerBuildCommand,
        scorerBuildEnabled: config.get("scorerBuildEnabled") ?? defaultCfg().scorerBuildEnabled,
        sharedVars: config.get("sharedVars") ?? defaultCfg().sharedVars,
        // judge configs for heuristic retry behavior
        judgeTimeLimitMs: config.get("judgeTimeLimitMs") ?? defaultCfg().judgeTimeLimitMs,
        judgeRetries: config.get("judgeRetries") ?? defaultCfg().judgeRetries,
        judgeRealTimeoutFactor: config.get("judgeRealTimeoutFactor") ?? defaultCfg().judgeRealTimeoutFactor,
      };

      const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL to fetch generator (leave empty to use existing gen.py)" });
      const genPath = path.join(root, String(cfg.genFilename));
      if (urlOrShort) {
        try {
          await fetchGeneratorAndSave(urlOrShort, genPath, outputChannel);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
          return;
        }
      } else {
        if (!(await fileExists(genPath))) {
          vscode.window.showErrorMessage("No gen.py in workspace. Provide a URL or create gen.py first.");
          return;
        }
      }

      const mainPath = path.join(root, String(cfg.mainFilename));
      if (!(await fileExists(mainPath))) {
        const ok = await vscode.window.showWarningMessage("main file not found in workspace. Continue without main build/run?", "Cancel");
        if (ok === "Cancel") return;
      }
      const scorerPath = path.join(root, String(cfg.scorerFilename));
      if (!(await fileExists(scorerPath))) {
        const ok = await vscode.window.showWarningMessage("scorer file not found in workspace. Continue without scorer (just run main)?", "Continue", "Cancel");
        if (ok !== "Continue") return;
      }

      const manual = await vscode.window.showInputBox({ prompt: "Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
      if (!manual) return;
      const seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
      if (seeds.length === 0) {
        vscode.window.showErrorMessage("No seeds provided.");
        return;
      }

      outputChannel.appendLine(`Heuristic run seeds: ${seeds.join(", ")}`);

      const outdir = path.resolve(root, String(cfg.outputDir ?? defaultCfg().outputDir));
      if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
      const inputsDir = path.join(outdir, "inputs");
      const outputsDir = path.join(outdir, "outputs");
      if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

      const results: Array<any> = [];

      let threads = Number(cfg.threads) || 0;
      if (threads <= 0) threads = getPhysicalCoreCount();
      outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);

      // ask for optional comment to store run logs
      const runComment = await vscode.window.showInputBox({ prompt: "Optional comment for this run (used in logs folder name). Leave empty for timestamp-only." });
      const runTs = new Date();
      const pad = (n:number) => String(n).padStart(2,'0');
      const tsName = `${runTs.getFullYear()}${pad(runTs.getMonth()+1)}${pad(runTs.getDate())}_${pad(runTs.getHours())}${pad(runTs.getMinutes())}${pad(runTs.getSeconds())}`;
      const logsBase = path.join(outdir, "logs");
      const logsFolderName = safeFilenamePart((runComment && runComment.trim().length>0)? runComment.trim() : `run`) + `_${tsName}`;
      const logsFolder = path.join(logsBase, logsFolderName);
      try { if (!fs.existsSync(logsFolder)) fs.mkdirSync(logsFolder, { recursive: true }); } catch (e:any) { outputChannel.appendLine(`Failed to create logs folder: ${String(e)}`); }

      // build main (only if enabled)
      if (cfg.mainBuildEnabled && cfg.mainBuildCommand && String(cfg.mainBuildCommand).trim().length > 0) {
        outputChannel.appendLine(`Running build: ${cfg.mainBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.mainBuildCommand).replace(/\{out\}/g, `${cfg.mainExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true, detached: process.platform !== 'win32' });
          runningProcesses.set("build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Build failed: ${String(e)}`);
          return;
        }
      } else {
        outputChannel.appendLine(`Build skipped (mainBuildEnabled=${cfg.mainBuildEnabled})`);
      }

      // build scorer (only if enabled)
      if (cfg.scorerBuildEnabled && (cfg.scorerBuildCommand && String(cfg.scorerBuildCommand).trim().length > 0) && (await fileExists(path.join(root, String(cfg.scorerFilename))))) {
        outputChannel.appendLine(`Running scorer build: ${cfg.scorerBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.scorerBuildCommand).replace(/\{out\}/g, `${cfg.scorerExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true, detached: process.platform !== 'win32' });
          runningProcesses.set("scorer_build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("scorer_build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Scorer build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Scorer build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Scorer build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Scorer build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Scorer build failed: ${String(e)}`);
          return;
        }
      } else {
        outputChannel.appendLine(`Scorer build skipped (scorerBuildEnabled=${cfg.scorerBuildEnabled})`);
      }

      let cancelled = false;

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Heuristic run — threads: ${threads}`, cancellable: true }, async (progress, token) => {
        const total = seeds.length;
        let completed = 0;
        const queue: Promise<void>[] = [];
        let idx = 0;

        token.onCancellationRequested(() => {
          cancelled = true;
          outputChannel.appendLine("Cancellation requested — killing running processes...");
          killAllRunning();
        });

        const worker = async () => {
          // per-worker warmup to reduce first-run overhead
          try { await runWarmup(root, Math.max(1000, Number(cfg.timeoutMsGen) || defaultCfg().timeoutMsGen), outputChannel); } catch {}
          while (true) {
            if (cancelled) return;
            const myIndex = idx;
            idx++;
            if (myIndex >= seeds.length) return;
            const s = seeds[myIndex];
            progress.report({ message: `Running seed ${s} (${myIndex + 1}/${total})`, increment: (100 / total) });
            outputChannel.appendLine(`=== Heuristic Seed ${s} ===`);
            try {
              // Retry logic: attempt up to judgeRetries to obtain a run within judgeTimeLimitMs
              const attempts = Math.max(1, Number(cfg.judgeRetries) || 1);
              const timeLimitMs = Number(cfg.judgeTimeLimitMs) || defaultCfg().judgeTimeLimitMs;
              const realTimeoutFactor = Number(cfg.judgeRealTimeoutFactor) || defaultCfg().judgeRealTimeoutFactor;
              let acceptedRun: any = null;
              let lastRun: any = null;
              const attemptsList: any[] = [];
              for (let attempt = 1; attempt <= attempts; attempt++) {
                if (cancelled) break;
                outputChannel.appendLine(`Seed ${s}: attempt ${attempt}/${attempts}`);
                const timeoutForThisRun = Math.max(Number(cfg.timeoutMsMain) || defaultCfg().timeoutMsMain, timeLimitMs * realTimeoutFactor + 1000);
                const r = await runSingleSeed(s, cfg, root, outdir, outputChannel, timeoutForThisRun);
                lastRun = r;
                attemptsList.push(r);
                const measuredMs = (typeof r.mainTimeMs === "number" && !isNaN(r.mainTimeMs)) ? r.mainTimeMs : r.realTimeMs;
                const measuredStr = typeof measuredMs === "number" ? `${measuredMs} ms` : "N/A";
                outputChannel.appendLine(`Seed ${s}: attempt ${attempt} result: ok=${r.ok} measured=${measuredStr} stage=${r.stage ?? 'unknown'} err=${r.err ?? ""}`);
                if (r.ok && typeof measuredMs === "number" && measuredMs <= timeLimitMs) {
                  acceptedRun = r;
                  outputChannel.appendLine(`Seed ${s}: accepted on attempt ${attempt} (measured ${measuredMs} ms <= ${timeLimitMs} ms)`);
                  break;
                }
              }

              const resObj: any = {
                seed: s,
                main_ok: false,
                main_exitCode: null,
                main_err: null,
                main_stdout: null,
                mainTimeMs: null,
                realTimeMs: null,
                scorer_ok: null,
                scorer_exitCode: null,
                scorer_err: null,
                scorer_stdout: null,
                scorer_score: null
              };

              if (acceptedRun) {
                resObj.main_ok = true;
                resObj.main_exitCode = acceptedRun.exitCode;
                resObj.main_err = acceptedRun.err;
                resObj.main_stdout = acceptedRun.stdout;
                resObj.mainTimeMs = acceptedRun.mainTimeMs;
                resObj.realTimeMs = acceptedRun.realTimeMs;
                outputChannel.appendLine(`Seed ${s}: main OK (cpu=${resObj.mainTimeMs ?? "N/A"} ms realtime=${resObj.realTimeMs ?? "N/A"} ms) — running scorer...`);
                if (await fileExists(path.join(root, String(cfg.scorerFilename)))) {
                  try {
                    const sc = await runScorer(s, cfg, root, outdir, outputChannel);
                    resObj.scorer_ok = sc.ok;
                    resObj.scorer_exitCode = sc.exitCode;
                    resObj.scorer_err = sc.err;
                    resObj.scorer_stdout = sc.stdout;
                    resObj.scorer_score = sc.parsedScore ?? null;
                    if (sc.ok) {
                      outputChannel.appendLine(`Seed ${s}: scorer OK (score: ${sc.parsedScore ?? "N/A"})`);
                    } else {
                      outputChannel.appendLine(`Seed ${s}: scorer FAILED - ${sc.err}`);
                    }
                  } catch (e:any) {
                    resObj.scorer_ok = false;
                    resObj.scorer_err = String(e);
                    outputChannel.appendLine(`Seed ${s}: scorer exception - ${String(e)}`);
                  }
                } else {
                  outputChannel.appendLine(`Seed ${s}: scorer not found — skipping scorer.`);
                }
              } else {
                // no accepted run within retries -> mark TLE and set score -1
                if (lastRun) {
                  let fastestMs: number | null = null;
                  let fastestReal: number | null = null;
                  for (const a of attemptsList) {
                    const m = (typeof a.mainTimeMs === "number" && !isNaN(a.mainTimeMs)) ? a.mainTimeMs : a.realTimeMs;
                    if (typeof m === "number") {
                      if (fastestMs === null || m < fastestMs) {
                        fastestMs = m;
                        fastestReal = a.realTimeMs ?? null;
                      }
                    }
                  }
                  resObj.main_ok = false;
                  resObj.main_exitCode = lastRun.exitCode;
                  resObj.main_err = lastRun.err || 'TLE';
                  resObj.main_stdout = lastRun.stdout;
                  resObj.mainTimeMs = fastestMs !== null ? fastestMs : lastRun.mainTimeMs;
                  resObj.realTimeMs = fastestReal !== null ? fastestReal : lastRun.realTimeMs;
                } else {
                  resObj.main_ok = false;
                  resObj.main_err = 'TLE';
                }
                resObj.scorer_score = -1;
                outputChannel.appendLine(`Seed ${s}: all attempts exceeded time limit -> marked TLE`);
              }

              results[myIndex] = resObj;

              // write per-seed outputs into logs folder (if exists)
              try {
                const sf = safeFilenamePart(s);
                const outFile = path.join(outputsDir, `out_${sf}.txt`);
                const logOutFile = path.join(logsFolder, `out_${myIndex+1}.txt`);
                if (fs.existsSync(outFile)) {
                  try { fs.copyFileSync(outFile, logOutFile); } catch(e:any){ try { fs.writeFileSync(logOutFile, fs.readFileSync(outFile,'utf8'),'utf8'); } catch(_){} }
                } else {
                  // if output not present, still write main stdout if available
                  if (resObj.main_stdout) {
                    try { fs.writeFileSync(logOutFile, String(resObj.main_stdout),'utf8'); } catch(_){} 
                  }
                }
                // dump current results snapshot (sanitize for heuristic: remove main_stdout and include shared_vars)
                try {
                  const sanitized = (results || []).map((r:any) => {
                    const copy: any = Object.assign({}, r || {});
                    try { delete copy.main_stdout; } catch {}
                    try {
                      const seedVal = r && r.seed ? String(r.seed) : null;
                      if (seedVal) {
                        const sf = safeFilenamePart(seedVal);
                        const sharedPath = path.join(outputsDir, `shared_${sf}.json`);
                        if (fs.existsSync(sharedPath)) {
                          try { copy.shared_vars = JSON.parse(fs.readFileSync(sharedPath, 'utf8')); } catch { copy.shared_vars = null; }
                        } else {
                          copy.shared_vars = null;
                        }
                      } else {
                        copy.shared_vars = null;
                      }
                    } catch { copy.shared_vars = null; }
                    return copy;
                  });
                  fs.writeFileSync(path.join(logsFolder, 'results.json'), JSON.stringify(sanitized, null, 2), 'utf8');
                } catch(_) {}
              } catch (e:any) { outputChannel.appendLine(`Failed to write per-seed log: ${String(e)}`); }

            } catch (e:any) {
              outputChannel.appendLine(`Seed ${s}: Exception - ${String(e)}`);
              results[myIndex] = { seed: s, main_ok: false, main_err: String(e) };
            }
            completed++;
            progress.report({ message: `Completed ${completed}/${total}`, increment: (100 / total) });
          }
        };

        for (let i = 0; i < threads; i++) {
          queue.push(worker());
        }
        await Promise.all(queue);
      });

      // combine outputs
      try {
        const combinedPath = path.join(outdir, "out.txt");
        const parts: string[] = [];
        for (let i = 0; i < seeds.length; i++) {
          const s = seeds[i];
          const sf = safeFilenamePart(s);
          const fn = path.join(outdir, "outputs", `out_${sf}.txt`);
          if (fs.existsSync(fn)) parts.push(fs.readFileSync(fn, "utf8"));
        }
        fs.writeFileSync(combinedPath, parts.join("\n"), "utf8");
        vscode.window.showInformationMessage(`Heuristic run completed. Combined output written to ${combinedPath}`);
        outputChannel.appendLine(`Combined output written to ${combinedPath}`);
      } catch (e: any) {
        outputChannel.appendLine(`Failed to combine outputs: ${String(e)}`);
      }

      // write summary with stats
      try {
        const execInfo: any = {
          genCommand: cfg.genCommand,
          mainRunCommand: cfg.mainRunCommand,
          mainBuildEnabled: cfg.mainBuildEnabled,
        };
        if (cfg.mainBuildEnabled) execInfo.mainBuildCommand = cfg.mainBuildCommand;
        if (await fileExists(path.join(root, String(cfg.scorerFilename)))) {
          execInfo.scorerRunCommand = cfg.scorerRunCommand;
          execInfo.scorerBuildEnabled = cfg.scorerBuildEnabled;
          if (cfg.scorerBuildEnabled) execInfo.scorerBuildCommand = cfg.scorerBuildCommand;
        }
        writeSummaryWithStats(outdir, seeds, results, threads, root, outputChannel, "NPC Heuristic Run Summary", execInfo);
        try {
          const doc = await vscode.workspace.openTextDocument(path.join(outdir, "summary.md"));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {}
        try { if (fs.existsSync(logsFolder)) outputChannel.appendLine(`Heuristic logs saved to ${logsFolder}`); } catch(e:any){}
      } catch (e:any) {
        outputChannel.appendLine(`Failed to write heuristic summary: ${String(e)}`);
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  const genEnvHelperCommand = vscode.commands.registerCommand("npc.generateEnvHelper", async () => {
    try {
      const root = ensureWorkspace();
      await generateEnvironmentHelperFile(root, outputChannel);
    } catch (e:any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  // ---- NEW: judge command (reads seeds.txt, TL & retries, scorer run to finalize score) ----
  const runJudgeCommand = vscode.commands.registerCommand("npc.runJudge", async () => {
    try {
      const root = ensureWorkspace();
      const config = getConfig();
      const cfg = {
        pythonPath: config.get("pythonPath") || defaultCfg().pythonPath,
        genFilename: config.get("genFilename") || defaultCfg().genFilename,
        mainFilename: config.get("mainFilename") || defaultCfg().mainFilename,
        timeoutMsGen: config.get("timeoutMsGen") ?? defaultCfg().timeoutMsGen,
        timeoutMsMain: config.get("timeoutMsMain") ?? defaultCfg().timeoutMsMain,
        timeoutMsScorer: config.get("timeoutMsScorer") ?? defaultCfg().timeoutMsScorer,
        maxOutputBytes: config.get("maxOutputBytes") ?? defaultCfg().maxOutputBytes,
        outputDir: config.get("outputDir") || defaultCfg().outputDir,
        threads: config.get("threads") ?? defaultCfg().threads,
        genCommand: config.get("genCommand") || defaultCfg().genCommand,
        mainBuildCommand: config.get("mainBuildCommand") || defaultCfg().mainBuildCommand,
        mainBuildEnabled: config.get("mainBuildEnabled") ?? defaultCfg().mainBuildEnabled,
        mainRunCommand: config.get("mainRunCommand") || defaultCfg().mainRunCommand,
        mainExec: config.get("mainExec") || defaultCfg().mainExec,
        scorerFilename: config.get("scorerFilename") || defaultCfg().scorerFilename,
        scorerRunCommand: config.get("scorerRunCommand") || defaultCfg().scorerRunCommand,
        scorerExec: config.get("scorerExec") || defaultCfg().scorerExec,
        scorerBuildCommand: config.get("scorerBuildCommand") || defaultCfg().scorerBuildCommand,
        scorerBuildEnabled: config.get("scorerBuildEnabled") ?? defaultCfg().scorerBuildEnabled,
        sharedVars: config.get("sharedVars") ?? defaultCfg().sharedVars,
        // judge configs
        judgeTimeLimitMs: config.get("judgeTimeLimitMs") ?? defaultCfg().judgeTimeLimitMs,
        judgeRetries: config.get("judgeRetries") ?? defaultCfg().judgeRetries,
        judgeRealTimeoutFactor: config.get("judgeRealTimeoutFactor") ?? defaultCfg().judgeRealTimeoutFactor,
      };

      // seeds.txt must exist at workspace root
      const seedsFile = path.join(root, "seeds.txt");
      // read seeds.txt as binary and detect encoding (UTF-8 / UTF-8 BOM / UTF-16 LE/BE heuristics)
      const rawBuf = await readFileAsync(seedsFile); // Buffer (no encoding)
      let raw: string;
      if (Buffer.isBuffer(rawBuf)) {
        const b: Buffer = rawBuf;
        if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
          // UTF-8 with BOM
          raw = b.toString("utf8").replace(/^\uFEFF/, "");
        } else if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
          // UTF-16 LE BOM
          raw = b.toString("utf16le");
        } else if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
          // UTF-16 BE BOM -> swap bytes then decode as LE
          const swapped = Buffer.allocUnsafe(b.length);
          for (let i = 0; i + 1 < b.length; i += 2) {
            swapped[i] = b[i + 1];
            swapped[i + 1] = b[i];
          }
          // If odd length, copy last byte as-is
          if (b.length % 2 === 1) swapped[b.length - 1] = b[b.length - 1];
          raw = swapped.toString("utf16le");
        } else {
          // heuristic: if many zero bytes in odd positions => likely UTF-16LE (ASCII chars high byte = 0)
          let zeroOdd = 0;
          let zeroEven = 0;
          const maxCheck = Math.min(b.length, 1024);
          for (let i = 0; i < maxCheck; i++) {
            if (b[i] === 0) {
              if (i % 2 === 0) zeroEven++; else zeroOdd++;
            }
          }
          if (zeroOdd > zeroEven && zeroOdd > maxCheck * 0.25) {
            raw = b.toString("utf16le");
          } else {
            // default to utf8
            raw = b.toString("utf8");
          }
        }
      } else {
        raw = String(rawBuf);
      }

      // now split lines, strip comments and empty lines
      const seeds = raw.split(/\r?\n/).map(s => s.replace(/#.*$/,'').trim()).filter(Boolean);
      if (seeds.length === 0) {
        vscode.window.showErrorMessage("seeds.txt contains no seeds.");
        return;
      }


      outputChannel.appendLine(`Judge run seeds (from seeds.txt): ${seeds.join(", ")}`);

      const outdir = path.resolve(root, String(cfg.outputDir ?? defaultCfg().outputDir));
      if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
      const inputsDir = path.join(outdir, "inputs");
      const outputsDir = path.join(outdir, "outputs");
      if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

      const results: Array<any> = [];

      // optional run comment and logs folder for judge run
      const runComment = await vscode.window.showInputBox({ prompt: "Optional comment for this judge run (used in logs folder name). Leave empty for timestamp-only." });
      const runTs = new Date();
      const pad = (n:number) => String(n).padStart(2,'0');
      const tsName = `${runTs.getFullYear()}${pad(runTs.getMonth()+1)}${pad(runTs.getDate())}_${pad(runTs.getHours())}${pad(runTs.getMinutes())}${pad(runTs.getSeconds())}`;
      const logsBase = path.join(outdir, "logs");
      const logsFolderName = safeFilenamePart((runComment && runComment.trim().length>0)? runComment.trim() : `run`) + `_${tsName}`;
      const logsFolder = path.join(logsBase, logsFolderName);
      try { if (!fs.existsSync(logsFolder)) fs.mkdirSync(logsFolder, { recursive: true }); } catch (e:any) { outputChannel.appendLine(`Failed to create logs folder: ${String(e)}`); }

      // threads not used for judge for simplicity (we will still allow multi-worker)
      let threads = Number(cfg.threads) || 0;
      if (threads <= 0) threads = getPhysicalCoreCount();
      outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);

      // build main if specified AND enabled
      if (cfg.mainBuildEnabled && cfg.mainBuildCommand && String(cfg.mainBuildCommand).trim().length > 0) {
        outputChannel.appendLine(`Running build: ${cfg.mainBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.mainBuildCommand).replace(/\{out\}/g, `${cfg.mainExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true, detached: process.platform !== 'win32' });
          runningProcesses.set("build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Build failed: ${String(e)}`);
          return;
        }
      } else {
        outputChannel.appendLine(`Build skipped (mainBuildEnabled=${cfg.mainBuildEnabled})`);
      }

      // build scorer if present and build command given AND enabled
      if (cfg.scorerBuildEnabled && (cfg.scorerBuildCommand && String(cfg.scorerBuildCommand).trim().length > 0) && (await fileExists(path.join(root, String(cfg.scorerFilename))))) {
        outputChannel.appendLine(`Running scorer build: ${cfg.scorerBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.scorerBuildCommand).replace(/\{out\}/g, `${cfg.scorerExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true, detached: process.platform !== 'win32' });
          runningProcesses.set("scorer_build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("scorer_build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Scorer build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Scorer build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Scorer build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Scorer build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Scorer build failed: ${String(e)}`);
          return;
        }
      } else {
        outputChannel.appendLine(`Scorer build skipped (scorerBuildEnabled=${cfg.scorerBuildEnabled})`);
      }

      let cancelled = false;

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Judge run — seeds: ${seeds.length} — TL ${cfg.judgeTimeLimitMs} ms — retries ${cfg.judgeRetries}`, cancellable: true }, async (progress, token) => {
        const total = seeds.length;
        let completed = 0;
        const queue: Promise<void>[] = [];
        let idx = 0;

        token.onCancellationRequested(() => {
          cancelled = true;
          outputChannel.appendLine("Cancellation requested — killing running processes...");
          killAllRunning();
        });

        const worker = async () => {
          // per-worker warmup to reduce first-run overhead
          try { await runWarmup(root, Math.max(1000, Number(cfg.timeoutMsGen) || defaultCfg().timeoutMsGen), outputChannel); } catch {}
          while (true) {
            if (cancelled) return;
            const myIndex = idx;
            idx++;
            if (myIndex >= seeds.length) return;
            const s = seeds[myIndex];
            progress.report({ message: `Judging seed ${s} (${myIndex + 1}/${total})`, increment: (100 / total) });
            outputChannel.appendLine(`=== Judge Seed ${s} ===`);

            try {
              // we'll attempt up to judgeRetries times to get a run that meets judgeTimeLimitMs
              const attempts = Math.max(1, Number(cfg.judgeRetries) || 1);
              const timeLimitMs = Number(cfg.judgeTimeLimitMs) || defaultCfg().judgeTimeLimitMs;
              const realTimeoutFactor = Number(cfg.judgeRealTimeoutFactor) || defaultCfg().judgeRealTimeoutFactor;
              let acceptedRun: any = null;
              let lastRun: any = null;
              const attemptsList: any[] = [];

              for (let attempt = 1; attempt <= attempts; attempt++) {
                if (cancelled) break;
                outputChannel.appendLine(`Seed ${s}: attempt ${attempt}/${attempts}`);
                // choose a real-time timeout to pass to runSingleSeed so we don't wait forever.
                const timeoutForThisRun = Math.max(Number(cfg.timeoutMsMain) || defaultCfg().timeoutMsMain, timeLimitMs * realTimeoutFactor + 1000);
                const r = await runSingleSeed(s, cfg, root, outdir, outputChannel, timeoutForThisRun);
                lastRun = r;
                attemptsList.push(r);
                // choose measured time: prefer cpu if available
                const measuredMs = (typeof r.mainTimeMs === "number" && !isNaN(r.mainTimeMs)) ? r.mainTimeMs : r.realTimeMs;
                const measuredStr = typeof measuredMs === "number" ? `${measuredMs} ms` : "N/A";
                outputChannel.appendLine(`Seed ${s}: attempt ${attempt} result: ok=${r.ok} measured=${measuredStr} stage=${r.stage ?? 'unknown'} err=${r.err ?? ""}`);

                // if run succeeded (exit 0) and measured time exists and <= limit -> accept
                if (r.ok && typeof measuredMs === "number" && measuredMs <= timeLimitMs) {
                  acceptedRun = r;
                  outputChannel.appendLine(`Seed ${s}: accepted on attempt ${attempt} (measured ${measuredMs} ms <= ${timeLimitMs} ms)`);
                  break;
                }
                // if run succeeded but measured time not available -> use realTimeMs if present
                if (r.ok && typeof measuredMs === "number" && measuredMs > timeLimitMs) {
                  outputChannel.appendLine(`Seed ${s}: attempt ${attempt} exceeded time limit (${measuredMs} > ${timeLimitMs})`);
                  // continue to retry
                }
                // if run failed or no measured value, continue to retry until exhausted
              }

              let finalResult: any = null;
              if (acceptedRun) {
                finalResult = {
                  seed: s,
                  main_ok: true,
                  main_exitCode: acceptedRun.exitCode,
                  main_err: acceptedRun.err,
                  main_stdout: acceptedRun.stdout,
                  mainTimeMs: acceptedRun.mainTimeMs,
                  realTimeMs: acceptedRun.realTimeMs,
                  scorer_ok: null,
                  scorer_exitCode: null,
                  scorer_err: null,
                  scorer_stdout: null,
                  scorer_score: null
                };
                // run scorer if exists
                if (await fileExists(path.join(root, String(cfg.scorerFilename)))) {
                  try {
                    const sc = await runScorer(s, cfg, root, outdir, outputChannel);
                    finalResult.scorer_ok = sc.ok;
                    finalResult.scorer_exitCode = sc.exitCode;
                    finalResult.scorer_err = sc.err;
                    finalResult.scorer_stdout = sc.stdout;
                    finalResult.scorer_score = sc.parsedScore ?? null;
                    if (sc.ok) {
                      outputChannel.appendLine(`Seed ${s}: scorer OK (score: ${sc.parsedScore ?? "N/A"})`);
                    } else {
                      outputChannel.appendLine(`Seed ${s}: scorer FAILED - ${sc.err}`);
                    }
                  } catch (e:any) {
                    finalResult.scorer_ok = false;
                    finalResult.scorer_err = String(e);
                    outputChannel.appendLine(`Seed ${s}: scorer exception - ${String(e)}`);
                  }
                } else {
                  outputChannel.appendLine(`Seed ${s}: scorer not found — skipping scorer.`);
                }
              } else {
                // no accepted run within retries -> mark TLE or use fastest attempt as reported time
                if (lastRun) {
                  const lastErr = lastRun.err ?? null;
                  // choose the fastest measured time among attemptsList (prefer cpu/mainTimeMs, fallback to realTimeMs)
                  let fastestMs: number | null = null;
                  let fastestReal: number | null = null;
                  for (const a of attemptsList) {
                    const m = (typeof a.mainTimeMs === "number" && !isNaN(a.mainTimeMs)) ? a.mainTimeMs : a.realTimeMs;
                    if (typeof m === "number") {
                      if (fastestMs === null || m < fastestMs) {
                        fastestMs = m;
                        fastestReal = a.realTimeMs ?? null;
                      }
                    }
                  }
                  finalResult = {
                    seed: s,
                    main_ok: false,
                    main_exitCode: lastRun.exitCode,
                    main_err: lastErr || `TLE`,
                    main_stdout: lastRun.stdout,
                    mainTimeMs: fastestMs !== null ? fastestMs : lastRun.mainTimeMs,
                    realTimeMs: fastestReal !== null ? fastestReal : lastRun.realTimeMs,
                    scorer_ok: null,
                    scorer_exitCode: null,
                    scorer_err: null,
                    scorer_stdout: null,
                    scorer_score: -1
                  };
                  outputChannel.appendLine(`Seed ${s}: all attempts exceeded time limit -> marked TLE/ERR (see err); reported time set to fastest attempt if available`);
                } else {
                  finalResult = {
                    seed: s,
                    main_ok: false,
                    main_err: `TLE`,
                    main_stdout: null,
                    mainTimeMs: null,
                    realTimeMs: null,
                    scorer_score: -1
                  };
                  outputChannel.appendLine(`Seed ${s}: no run information available -> marked TLE`);
                }
              }

              results[myIndex] = finalResult;

              // write per-seed outputs into logs folder (if exists)
              try {
                const sf = safeFilenamePart(s);
                const outFile = path.join(outputsDir, `out_${sf}.txt`);
                const logOutFile = path.join(logsFolder, `out_${myIndex+1}.txt`);
                if (fs.existsSync(outFile)) {
                  try { fs.copyFileSync(outFile, logOutFile); } catch(e:any){ try { fs.writeFileSync(logOutFile, fs.readFileSync(outFile,'utf8'),'utf8'); } catch(_){} }
                } else {
                  if (results[myIndex] && results[myIndex].main_stdout) {
                    try { fs.writeFileSync(logOutFile, String(results[myIndex].main_stdout),'utf8'); } catch(_) {}
                  }
                }
                try {
                  const sanitized = (results || []).map((r:any) => {
                    const copy: any = Object.assign({}, r || {});
                    try { delete copy.main_stdout; } catch {}
                    try {
                      const seedVal = r && r.seed ? String(r.seed) : null;
                      if (seedVal) {
                        const sf = safeFilenamePart(seedVal);
                        const sharedPath = path.join(outputsDir, `shared_${sf}.json`);
                        if (fs.existsSync(sharedPath)) {
                          try { copy.shared_vars = JSON.parse(fs.readFileSync(sharedPath, 'utf8')); } catch { copy.shared_vars = null; }
                        } else {
                          copy.shared_vars = null;
                        }
                      } else {
                        copy.shared_vars = null;
                      }
                    } catch { copy.shared_vars = null; }
                    return copy;
                  });
                  fs.writeFileSync(path.join(logsFolder, 'results.json'), JSON.stringify(sanitized, null, 2), 'utf8');
                } catch(_) {}
              } catch (e:any) { outputChannel.appendLine(`Failed to write per-seed log: ${String(e)}`); }

            } catch (e:any) {
              outputChannel.appendLine(`Seed ${s}: Exception - ${String(e)}`);
              results[myIndex] = { seed: s, main_ok: false, main_err: String(e) };
            }

            completed++;
            progress.report({ message: `Completed ${completed}/${total}`, increment: (100 / total) });
          }
        };

        for (let i = 0; i < threads; i++) {
          queue.push(worker());
        }
        await Promise.all(queue);
      });

      // combine outputs (same as before)
      try {
        const combinedPath = path.join(outdir, "out.txt");
        const parts: string[] = [];
        for (let i = 0; i < seeds.length; i++) {
          const s = seeds[i];
          const sf = safeFilenamePart(s);
          const fn = path.join(outdir, "outputs", `out_${sf}.txt`);
          if (fs.existsSync(fn)) parts.push(fs.readFileSync(fn, "utf8"));
        }
        fs.writeFileSync(combinedPath, parts.join("\n"), "utf8");
        vscode.window.showInformationMessage(`Judge run completed. Combined output written to ${combinedPath}`);
        outputChannel.appendLine(`Combined output written to ${combinedPath}`);
      } catch (e: any) {
        outputChannel.appendLine(`Failed to combine outputs: ${String(e)}`);
      }

      // write judge summary
      try {
        const execInfo: any = {
          genCommand: cfg.genCommand,
          mainRunCommand: cfg.mainRunCommand,
          mainBuildEnabled: cfg.mainBuildEnabled,
          judgeTimeLimitMs: cfg.judgeTimeLimitMs,
          judgeRetries: cfg.judgeRetries,
          judgeRealTimeoutFactor: cfg.judgeRealTimeoutFactor
        };
        if (cfg.mainBuildEnabled) execInfo.mainBuildCommand = cfg.mainBuildCommand;
        if (await fileExists(path.join(root, String(cfg.scorerFilename)))) {
          execInfo.scorerRunCommand = cfg.scorerRunCommand;
          execInfo.scorerBuildEnabled = cfg.scorerBuildEnabled;
          if (cfg.scorerBuildEnabled) execInfo.scorerBuildCommand = cfg.scorerBuildCommand;
        }
        writeSummaryWithStats(outdir, seeds, results, threads, root, outputChannel, "NPC Judge Summary", execInfo);
        try {
          const doc = await vscode.workspace.openTextDocument(path.join(outdir, "summary.md"));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {}
        try { if (fs.existsSync(logsFolder)) outputChannel.appendLine(`Judge logs saved to ${logsFolder}`); } catch(e:any){}
      } catch (e:any) {
        outputChannel.appendLine(`Failed to write judge summary: ${String(e)}`);
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  context.subscriptions.push(fetchCommand, runCommand, runHeuristicCommand, runJudgeCommand, genEnvHelperCommand);
}

export function deactivate() {
  try { killAllRunning(); } catch {}
}
