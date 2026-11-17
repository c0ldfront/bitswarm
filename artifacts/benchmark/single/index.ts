import mix from './mix.ts';
import score from './score.ts';
import route from './route.ts';
const modes:Record<string,number[]>={mix,score,route};
const args=process.argv.slice(2);
if(args.length!==2||!modes[args[0]]||!/^\s*[+-]?\d+$/.test(args[1])||!Number.isInteger(Number(args[1]))||Number(args[1])<0||Number(args[1])>63){console.log('invalid');process.exit(2);}
console.log(modes[args[0]][Number(args[1])]);
