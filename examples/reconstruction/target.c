#include <stdio.h>
#include <stdlib.h>
#include <string.h>
// Small finite-domain application used for complete behavioral reconstruction.
// The reconstruction adapter receives only the compiled executable, not this file.
int main(int argc,char **argv) {
  if(argc!=3){puts("invalid");return 2;}
  char *end;long x=strtol(argv[2],&end,10);
  if(!argv[2][0]||*end||x<0||x>63){puts("invalid");return 2;}
  if(!strcmp(argv[1],"mix"))printf("%ld\n",((x*13)^37)&63);
  else if(!strcmp(argv[1],"score"))printf("%ld\n",(x*x+7*x+11)%97);
  else if(!strcmp(argv[1],"route"))printf("%ld\n",x<12?3:x<40?((x+5)%7):9);
  else {puts("invalid");return 2;}
  return 0;
}
