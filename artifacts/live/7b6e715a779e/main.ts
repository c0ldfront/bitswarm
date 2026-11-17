function fail(message: string): number {
  process.stderr.write(`basename: ${message}\nTry 'basename --help' for more information.\n`);
  return 1;
}

function main(args: string[]): number {
  let multiple = false;
  let ending = '\n';
  let suffix = '';
  let i = 0;
  const options = ['multiple', 'suffix', 'zero', 'help', 'version'];
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') break;
    i++;
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const equal = arg.indexOf('=');
      const key = arg.slice(2, equal < 0 ? undefined : equal);
      const option = key && options.find(name => name.startsWith(key));
      if (!option) return fail(`unrecognized option '${arg}'`);
      if (option === 'suffix') {
        if (equal < 0 && i === args.length) return fail("option '--suffix' requires an argument");
        suffix = equal < 0 ? args[i++] : arg.slice(equal + 1);
        multiple = true;
      } else {
        if (equal >= 0) return fail(`option '--${option}' doesn't allow an argument`);
        if (option === 'multiple') multiple = true;
        if (option === 'zero') ending = '\0';
        if (option === 'help' || option === 'version') {
          console.log(option === 'help' ? 'Usage: basename [-az] [-s SUFFIX] NAME...\n       basename NAME [SUFFIX]' : 'basename (Node.js implementation)');
          return 0;
        }
      }
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (flag === 'a') multiple = true;
      else if (flag === 'z') ending = '\0';
      else if (flag === 's') {
        if (j + 1 === arg.length && i === args.length) return fail("option requires an argument -- 's'");
        suffix = j + 1 < arg.length ? arg.slice(j + 1) : args[i++];
        multiple = true;
        break;
      } else return fail(`invalid option -- '${flag}'`);
    }
  }
  const count = args.length - i;
  if (!count) return fail('missing operand');
  if (!multiple && count > 2) return fail(`extra operand '${args[i + 2]}'`);
  if (!multiple && count === 2) suffix = args[i + 1];
  const stop = multiple ? args.length : i + 1;
  for (; i < stop; i++) {
    const path = args[i];
    let end = path.length;
    while (end && path[end - 1] === '/') end--;
    let name = end ? path.slice(path.lastIndexOf('/', end - 1) + 1, end) : path.slice(0, 1);
    if (suffix && name.length > suffix.length && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    process.stdout.write(name + ending);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
