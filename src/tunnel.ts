// src/tunnel.ts
import https from 'https';
import { execSync } from 'child_process';

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
  try {
    const ip = await fetchMyIP();
    console.log(`🚪 Your IP address for tunnel‑password: ${ip}`);
    // spawn localtunnel‑auth (loca.lt) with that IP as the password:
    execSync(
      `pnpm dlx localtunnel-auth --port 4000 --subdomain activity --auth "${ip}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error('❌ Failed to launch tunnel:', err);
    process.exit(1);
  }
}

main();
