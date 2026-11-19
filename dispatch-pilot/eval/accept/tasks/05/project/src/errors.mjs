// Something the user can put right by changing the command line. The command line prints the
// message and exits with 1; any other error is a bug and is left to crash.
export class UsageError extends Error {}
