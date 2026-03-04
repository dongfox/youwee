const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-with-esbuild-wrapper.cjs <command> [...args]');
  process.exit(1);
}

const env = { ...process.env };
if (process.platform === 'win32' && !env.ESBUILD_BINARY_PATH) {
  env.ESBUILD_BINARY_PATH = path.join(__dirname, 'esbuild-wrapper.cmd');
}

const child = spawn(args[0], args.slice(1), {
  stdio: 'inherit',
  shell: true,
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
