import type { Destination } from './state.ts';

/** The saved normalized endpoint and exact profile name identify a destination. */
export const sameDestination = (a: Destination | null | undefined, b: Destination | null | undefined): boolean => !!a && !!b && a.url === b.url && a.profile === b.profile;
