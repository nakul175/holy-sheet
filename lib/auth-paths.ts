const signInDestinations = /^\/(?:(?:embed\/)?pages\/[A-Za-z0-9_-]+|workspaces\/[A-Za-z0-9_-]+\/spaces)?$/;

export function safeSignInReturn(value: string | null) {
  return value && value.length <= 240 && signInDestinations.test(value) ? value : '/';
}
