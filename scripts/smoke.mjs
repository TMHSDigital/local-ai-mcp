// Spawns the built server over stdio and checks initialize + tools/list.
// Used in CI to catch a broken bin entry or registration error.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LOCAL_AI_DETECT_TIMEOUT_MS: "200" },
});
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
let buf = "";
const timer = setTimeout(() => {
  console.error("smoke: timed out");
  child.kill();
  process.exit(1);
}, 15000);
child.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\n").slice(0, -1)) {
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (msg.id === 2) {
      const n = msg.result.tools.length;
      clearTimeout(timer);
      child.kill();
      if (n < 10) {
        console.error(`smoke: only ${n} tools`);
        process.exit(1);
      }
      console.log(`smoke: ok (${msg.result.tools.length} tools, server ${JSON.stringify(serverInfo)})`);
      process.exit(0);
    }
  }
  buf = buf.split("\n").pop();
});
let serverInfo;
child.stdout.on("data", (d) => {
  const m = String(d).match(/"serverInfo":(\{[^}]*\})/);
  if (m) serverInfo = JSON.parse(m[1]);
});
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
