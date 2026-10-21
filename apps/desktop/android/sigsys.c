/*
 * lumen-sigsys: runs a command under ptrace and turns Android's seccomp traps
 * (SIGSYS) into -ENOSYS, so glibc and Node fall back to calls Android allows.
 * It only wakes on signals, never on ordinary system calls.
 * Usage: libsigsys.so <program> [args...]
 */
#include <errno.h>
#include <linux/elf.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#include <asm/ptrace.h>

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s program [args]\n", argv[0]); return 2; }
  pid_t child = fork();
  if (child == 0) {
    ptrace(PTRACE_TRACEME, 0, 0, 0);
    raise(SIGSTOP);
    execv(argv[1], argv + 1);
    perror("execv");
    _exit(127);
  }
  int status;
  waitpid(child, &status, 0); /* the SIGSTOP */
  ptrace(PTRACE_SETOPTIONS, child, 0,
         PTRACE_O_EXITKILL | PTRACE_O_TRACECLONE | PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK |
             PTRACE_O_TRACEEXEC);
  ptrace(PTRACE_CONT, child, 0, 0);
  static unsigned char seen[1024];
  int code = 0;
  for (;;) {
    pid_t w = waitpid(-1, &status, __WALL);
    if (w < 0) break;
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      if (w == child) {
        code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        if (WIFSIGNALED(status)) fprintf(stderr, "lumen-sigsys: child died of signal %d\n", WTERMSIG(status));
      }
      continue;
    }
    if (!WIFSTOPPED(status)) continue;
    int sig = WSTOPSIG(status);
    int event = status >> 16;
    if (event) { ptrace(PTRACE_CONT, w, 0, 0); continue; } /* clone, fork and exec events */
    if (sig == SIGSYS) {
      siginfo_t si;
      ptrace(PTRACE_GETSIGINFO, w, 0, &si);
      int nr = si.si_syscall;
      if (nr >= 0 && nr < 1024 && !seen[nr]) {
        seen[nr] = 1;
        fprintf(stderr, "lumen-sigsys: blocked syscall %d -> ENOSYS\n", nr);
      }
      struct user_pt_regs regs;
      struct iovec io = { &regs, sizeof regs };
      ptrace(PTRACE_GETREGSET, w, NT_PRSTATUS, &io);
      regs.regs[0] = (unsigned long long)-ENOSYS;
      ptrace(PTRACE_SETREGSET, w, NT_PRSTATUS, &io);
      ptrace(PTRACE_CONT, w, 0, 0); /* swallow the signal */
      continue;
    }
    /* New threads start with SIGSTOP; everything else is delivered as usual. */
    ptrace(PTRACE_CONT, w, 0, sig == SIGSTOP ? 0 : sig);
  }
  return code;
}
