export type StopOpenMap = Readonly<Record<string, boolean>>;

export const stopKey = (day: number, index: number): string => `${day}-${index}`;

export const isStopOpen = (m: StopOpenMap, key: string): boolean => m[key] === true;

export const toggleStop = (m: StopOpenMap, key: string): StopOpenMap => ({
  ...m,
  [key]: !isStopOpen(m, key),
});
