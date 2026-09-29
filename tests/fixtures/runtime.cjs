const fs = require('node:fs');
const mode = process.argv[2];
switch (mode) {
  case 'info':
    console.log(JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd(), env: process.env.DEMO_VALUE, inherited: process.env.WASMDBOX_HOST_ONLY }));
    break;
  case 'nonzero':
    console.log('before exit');
    console.error('guest diagnostic');
    process.exit(7);
    break;
  case 'throw': throw new Error('guest exception');
  case 'stdin': {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => { console.log(input.toUpperCase()); console.error('stderr done'); });
    break;
  }
  case 'large':
    process.stdout.write('O'.repeat(100_000));
    process.stderr.write('E'.repeat(100_000));
    break;
  case 'wait':
    console.log('started');
    setTimeout(() => console.log('completed'), 5_000);
    break;
  case 'ticker':
    fs.appendFileSync('/mounted/ticks.txt', 'start\n');
    setInterval(() => fs.appendFileSync('/mounted/ticks.txt', 'tick\n'), 50);
    break;
  case 'write':
    fs.writeFileSync(process.argv[3], 'saved by guest');
    console.log(fs.readFileSync(process.argv[3], 'utf8'));
    break;
  case 'read': console.log(fs.readFileSync(process.argv[3], 'utf8')); break;
  default: throw new Error('unknown probe');
}
