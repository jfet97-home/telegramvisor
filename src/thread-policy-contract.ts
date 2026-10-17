import { Schema } from "effect";

export const ThreadPolicy = Schema.Struct({
  generation: Schema.Number,
  excludedThreadIds: Schema.Array(Schema.String),
  interactiveThreadId: Schema.NullOr(Schema.String),
});
export type ThreadPolicySettings = typeof ThreadPolicy.Type;
