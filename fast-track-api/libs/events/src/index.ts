/**
 * Public API of `@libs/events`: the event contract shared by every service.
 *
 * It holds only types, constants and pure functions (no Nest module), so it can
 * be imported anywhere, including tests and the future outbox library.
 */
export * from './event-envelope.js';
export * from './topics.js';
