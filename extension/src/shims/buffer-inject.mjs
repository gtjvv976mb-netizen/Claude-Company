/* @solana/web3.js and the executor's byte decoders read `Buffer` as a global. The
   browser has none; esbuild injects this export into every bundle as that global. */
import { Buffer } from "buffer";
export { Buffer };
