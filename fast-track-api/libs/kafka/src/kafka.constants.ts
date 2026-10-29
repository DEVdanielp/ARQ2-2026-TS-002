/**
 * Dependency-injection tokens of the Kafka library.
 *
 * Nest injects classes by their type, but the Kafka client and the resolved
 * options are plain objects, not classes we own. A token is the "name" Nest
 * uses to find them: `@Inject(KAFKA_CLIENT)` asks for the shared client.
 * Symbols are used so they can never collide with another library's tokens.
 */

/** Token of the resolved `ResolvedKafkaOptions`. */
export const KAFKA_OPTIONS = Symbol('KAFKA_OPTIONS');

/** Token of the single `KafkaJS.Kafka` client instance of the service. */
export const KAFKA_CLIENT = Symbol('KAFKA_CLIENT');
