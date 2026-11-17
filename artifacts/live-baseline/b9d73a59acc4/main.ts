#!/usr/bin/env node
const args = process.argv.slice(2);
let i = 0;
let multiple = false;
let zero = false;
let suffix = '';

function fail(): never {
  process.stderr.write('basename: invalid arguments\n');
  process.exit(1);
}

function nextSuffix(): string {
  if (i >= args.length) fail();
  return args[i++];
}

while (i < args.length) {
  const arg = args[i];
  if (!arg.startsWith('-') || arg === '-') break;
  i++;
  if (arg === '--') break;
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!name) fail();
    if ('suffix'.startsWith(name)) {
      suffix = eq < 0 ? nextSuffix() : arg.slice(eq + 1);
      multiple = true;
    } else if (eq >= 0) fail();
    else if ('multiple'.startsWith(name)) multiple = true;
    else if ('zero'.startsWith(name)) zero = true;
    else fail();
    continue;
  }
  for (let j = 1; j < arg.length; j++) {
    if (arg[j] === 'a') multiple = true;
    else if (arg[j] === 'z') zero = true;
    else if (arg[j] === 's') {
      suffix = arg.slice(j + 1) || nextSuffix();
      multiple = true;
      break;
    } else fail();
  }
}

const count = args.length - i;
if (!count || (!multiple && count > 2)) fail();
if (!multiple && count === 2) suffix = args[i + 1];
const limit = multiple ? args.length : i + 1;
for (; i < limit; i++) {
  const path = args[i];
  let end = path.length;
  while (end && path[end - 1] === '/') end--;
  let name = end ? path.slice(path.lastIndexOf('/', end - 1) + 1, end) : path.slice(0, 1);
  if (suffix && name.length > suffix.length && name.endsWith(suffix)) {
    name = name.slice(0, -suffix.length);
  }
  process.stdout.write(name + (zero ? '\0' : '\n'));
}
