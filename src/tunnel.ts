// src/tunnel.ts
import https from 'https';
import { spawn } from 'child_process';

async function fetchMyIP(): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get('https://api.ipify.org', res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => resolve(buf.trim()));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  let ip: string;
  try {
    ip = await fetchMyIP();
    console.log(`🚪 Your IP address for tunnel‑password: ${ip}`);
  } catch (err) {
    console.error('⚠️  Could not fetch your public IP, skipping tunnel launch.', err);
    // we still stay alive so dev script doesn't kill the server
    process.stdin.resume();
    return;
  }

  // spawn the loca.lt tunnel in the foreground:
  const lt = spawn(
    'pnpm',
    ['dlx', 'localtunnel-auth', '--port', '4000', '--subdomain', 'activity', '--auth', ip],
    { shell: true, stdio: 'inherit' }
  );

  lt.on('error', err => {
    console.error('❌ Tunnel process failed to start:', err);
  });
  lt.on('exit', code => {
    console.error(`❌ Tunnel process exited with code ${code}. Will keep retrying on next dev restart.`);
    // do NOT process.exit() — we just log it
  });

  // keep this script alive even if the tunnel dies
  process.stdin.resume();
}

main().catch(err => {
  console.error('❌ tunnel.ts uncaught error:', err);
  process.stdin.resume();
});
