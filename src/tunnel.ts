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
    console.log(`🚪 Your IP address for tunnel-password: ${ip}`);
  } catch (err) {
    console.error('⚠️  Could not fetch your public IP, skipping tunnel launch.', err);
    return;
  }

  // spawn the localtunnel-auth process asynchronously:
  const lt = spawn(
    'pnpm',
    ['dlx', 'localtunnel-auth', '--port', '4000', '--subdomain', 'activity', '--auth', ip],
    {
      stdio: 'inherit',
      shell: true,
      detached: true,
    }
  );

  lt.on('error', err => {
    console.error('❌ Tunnel process failed to start:', err);
  });

  lt.on('exit', code => {
    if (code !== 0) {
      console.error(`❌ Tunnel process exited with code ${code}. (check your network/firewall)`);
    }
  });

  // detach so that Ctrl-C in the parent will still kill both:
  lt.unref();
}

main().catch(err => {
  console.error('❌ tunnel.ts failed:', err);
});
