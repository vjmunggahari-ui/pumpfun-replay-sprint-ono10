// HotLaunch entrypoint for the pump.fun replay sprint (paper bot, real ranking).
//
// The harness speaks the agent-fun/replay/v2 protocol on stdin/stdout. The
// vendored shim owns the wire; all trading logic lives in strategy.ts. This
// file only wires the two together. No randomness, no wall clock, no network.

import { runBot } from './vendor/makefun-bot.ts';
import { createHotLaunchBot } from './strategy.ts';

await runBot(createHotLaunchBot());
