export function greet(name: string): string {
  return `hello ${name}`;
}
export const msg = greet("dao");

export interface Greeter {
  say(name: string): string;
}
export class EnglishGreeter implements Greeter {
  say(name: string): string {
    return greet(name);
  }
}
export function outer(name: string): string {
  return inner(name);
}
function inner(name: string): string {
  return greet(name);
}
