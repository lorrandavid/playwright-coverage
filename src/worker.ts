import {mergeProcessCovs, ProcessCov, ScriptCov} from '@bcoe/v8-coverage';
import type {EncodedSourceMap} from '@jridgewell/trace-mapping';
import {parentPort} from 'worker_threads';
import {expose} from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter';
import {promises as fs} from 'fs';
import {convertToIstanbulCoverage, getSourceMap} from './data';

if (parentPort == null) {
  throw new Error('This script is meant to run as worker thread');
}

class CoverageWorker {
  /**
   * Invariant: if #queue.length > 0, conversion is active
   */
  #queue: string[] = [];

  #sources = new Map<string, string>();
  #sourceMaps = new Map<string, Promise<EncodedSourceMap | undefined>>();

  #totalCoverage: ProcessCov = {result: []};

  #markReady?: () => void;

  startConversion(path: string) {
    this.#queue.push(path);

    if (this.#queue.length === 1) {
      this.#convert();
    }
  }

  reset() {
    this.#queue.length = 0;
    this.#sources.clear();
    this.#totalCoverage = {result: []};
  }

  async #convert() {
    if (this.#queue.length === 0) {
      this.#markReady?.();
      return;
    }

    await macrotick(); // wait one tick to give the event loop some space to run

    const [file] = this.#queue as [string, ...string[]];
    console.log(`[CoverageWorker] #convert: processing file=${file}`);

    const coverage: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    console.log(`[CoverageWorker] #convert: parsed coverage=${JSON.stringify(coverage, null, 2)}`);
    await fs.unlink(file);

    if (isProcessCov(coverage)) {
      for (const script of coverage.result as (ScriptCov & {
        source?: string;
      })[]) {
        if (typeof script.source === 'string') {
          if (this.#sources.get(script.url) !== script.source) {
            this.#sources.set(script.url, script.source);
            this.#sourceMaps.set(
              script.url,
              getSourceMap(script.url, script.source),
            );
          }

          delete script.source;
        }
      }

      this.#totalCoverage = mergeProcessCovs([this.#totalCoverage, coverage]);
    }

    this.#queue.shift();
    this.#convert();
  }

  async getTotalCoverage(sourceRoot: string, exclude: readonly string[]) {
    if (this.#queue.length !== 0) {
      // We're still running
      await new Promise<void>(resolve => (this.#markReady = resolve));
    }

    const sourceMaps = new Map(
      await Promise.all(
        Array.from(this.#sourceMaps, ([url, promise]) =>
          promise.then(map => [url, map] as const),
        ),
      ),
    );

    return JSON.stringify(
      await convertToIstanbulCoverage(
        this.#totalCoverage,
        this.#sources,
        sourceMaps,
        exclude,
        sourceRoot,
      ),
    );
  }
}

export type {CoverageWorker};

expose(new CoverageWorker(), nodeEndpoint(parentPort));

function isProcessCov(obj: unknown): obj is ProcessCov {
  return (
    typeof obj === 'object' &&
    obj != null &&
    Array.isArray((obj as ProcessCov).result)
  );
}

function macrotick() {
  return new Promise(resolve => setTimeout(resolve));
}
