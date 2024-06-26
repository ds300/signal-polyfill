/**
 * @license
 * Copyright 2024 Bloomberg Finance L.P.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {computedGet, createComputed, type ComputedNode} from './computed.js';
import {
  SIGNAL,
  getActiveConsumer,
  isInNotificationPhase,
  producerAccessed,
  assertConsumerNode,
  setActiveConsumer,
  REACTIVE_NODE,
  type ReactiveNode,
  assertProducerNode,
  producerRemoveLiveConsumerAtIndex,
  producerUpdateValueVersion,
  consumerBeforeComputation,
  EFFECT_NODE,
  EffectNode,
  consumerAfterComputation,
  consumerMarkClean,
} from './graph.js';
import {createSignal, signalGetFn, signalSetFn, type SignalNode} from './signal.js';

const NODE: unique symbol = Symbol('node');

let isState: (s: any) => boolean, isComputed: (s: any) => boolean, isEffect: (s: any) => boolean;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Signal {
  // A read-write Signal
  export class State<T> {
    readonly [NODE]: SignalNode<T>;
    #brand() {}

    static {
      isState = (s) => #brand in s;
    }

    constructor(initialValue: T, options: Signal.Options<T> = {}) {
      const ref = createSignal<T>(initialValue);
      const node: SignalNode<T> = ref[SIGNAL];
      this[NODE] = node;
      node.wrapper = this;
      if (options) {
        const equals = options.equals;
        if (equals) {
          node.equal = equals;
        }
        node.watched = options[Signal.subtle.watched];
        node.unwatched = options[Signal.subtle.unwatched];
      }
    }

    public get(): T {
      if (!isState(this)) throw new TypeError('Wrong receiver type for Signal.State.prototype.get');
      return (signalGetFn<T>).call(this[NODE]);
    }

    public set(newValue: T): void {
      if (!isState(this)) throw new TypeError('Wrong receiver type for Signal.State.prototype.set');
      if (isInNotificationPhase()) {
        throw new Error('Writes to signals not permitted during Watcher callback');
      }
      const ref = this[NODE];
      signalSetFn<T>(ref, newValue);
    }
  }

  // A Signal which is a formula based on other Signals
  export class Computed<T> {
    readonly [NODE]: ComputedNode<T>;

    #brand() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static {
      isComputed = (c: any) => #brand in c;
    }

    // Create a Signal which evaluates to the value returned by the callback.
    // Callback is called with this signal as the parameter.
    constructor(computation: () => T, options?: Signal.Options<T>) {
      const ref = createComputed<T>(computation);
      const node = ref[SIGNAL];
      node.consumerAllowSignalWrites = true;
      this[NODE] = node;
      node.wrapper = this;
      if (options) {
        const equals = options.equals;
        if (equals) {
          node.equal = equals;
        }
        node.watched = options[Signal.subtle.watched];
        node.unwatched = options[Signal.subtle.unwatched];
      }
    }

    get(): T {
      if (!isComputed(this))
        throw new TypeError('Wrong receiver type for Signal.Computed.prototype.get');
      return computedGet(this[NODE]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnySignal<T = any> = State<T> | Computed<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnySink = Computed<any> | subtle.Effect<any>;

  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace subtle {
    // Run a callback with all tracking disabled (even for nested computed).
    export function untrack<T>(cb: () => T): T {
      let output: T;
      let prevActiveConsumer = null;
      try {
        prevActiveConsumer = setActiveConsumer(null);
        output = cb();
      } finally {
        setActiveConsumer(prevActiveConsumer);
      }
      return output;
    }

    // Returns ordered list of all signals which this one referenced
    // during the last time it was evaluated
    export function introspectSources(sink: AnySink): AnySignal[] {
      if (!isComputed(sink) && !isEffect(sink)) {
        throw new TypeError('Called introspectSources without a Computed or Watcher argument');
      }
      return sink[NODE].producerNode?.map((n) => n.wrapper) ?? [];
    }

    // Returns the subset of signal sinks which recursively
    // lead to an Effect which has not been disposed
    // Note: Only watched Computed signals will be in this list.
    export function introspectSinks(signal: AnySignal): AnySink[] {
      if (!isComputed(signal) && !isState(signal)) {
        throw new TypeError('Called introspectSinks without a Signal argument');
      }
      return signal[NODE].liveConsumerNode?.map((n) => n.wrapper) ?? [];
    }

    // True iff introspectSinks() is non-empty
    export function hasSinks(signal: AnySignal): boolean {
      if (!isComputed(signal) && !isState(signal)) {
        throw new TypeError('Called hasSinks without a Signal argument');
      }
      const liveConsumerNode = signal[NODE].liveConsumerNode;
      if (!liveConsumerNode) return false;
      return liveConsumerNode.length > 0;
    }

    // True iff introspectSources() is non-empty
    export function hasSources(signal: AnySink): boolean {
      if (!isComputed(signal) && !isEffect(signal)) {
        throw new TypeError('Called hasSources without a Computed or Watcher argument');
      }
      const producerNode = signal[NODE].producerNode;
      if (!producerNode) return false;
      return producerNode.length > 0;
    }

    type HandleNotify<T> = (this: Effect<T>, allowFurtherNotifications: () => void) => void;

    const defaultNotify: HandleNotify<any> = async function defaultNotify(
      allowFurtherNotifications,
    ) {
      await Promise.resolve();
      allowFurtherNotifications();
      if (this.shouldExecute()) {
        this.execute();
      }
    };

    export class Effect<T> {
      readonly [NODE]: EffectNode;

      #brand() {}
      static {
        isEffect = (w: any): w is Effect<any> => #brand in w;
      }

      constructor(execute: (this: Effect<T>) => T, notify: HandleNotify<T> = defaultNotify) {
        let node = Object.create(EFFECT_NODE) as EffectNode;
        node.wrapper = this;
        node.consumerMarkedDirty = () => {
          notify.call(this, () => {
            node.dirty = false;
          });
        };
        node.consumerAllowSignalWrites = false;
        node.producerNode = [];
        node.execute = execute;
        this[NODE] = node;
      }

      shouldExecute(): boolean {
        const node = this[NODE];
        if (!node.producerNode) return true;
        for (let i = 0; i < node.producerNode.length; i++) {
          producerUpdateValueVersion(node.producerNode[i]);
          if (node.producerLastReadVersion?.[i] !== node.producerNode[i].version) {
            return true;
          }
        }
        return false;
      }

      execute(): T {
        const node = this[NODE];
        if (isInNotificationPhase()) {
          throw new Error('Effects cannot be executed during the notification phase.');
        }
        const prevConsumer = consumerBeforeComputation(node);
        try {
          node.version++;
          return node.execute();
        } finally {
          consumerAfterComputation(node, prevConsumer);
          // Even if the effect throws, mark it as clean.
          consumerMarkClean(node);
          // todo: only check this if it didn't throw? Otherwise the underlying error will be swallowed?
          if (!node?.producerNode?.length) {
            throw new Error('Effects must consume at least one Signal.');
          }
        }
      }

      attach(): void {
        const node = this[NODE];
        node.dirty = false;
        node.consumerIsLive = true;
        if (!node.producerNode?.length) return;
        const prev = setActiveConsumer(node);
        try {
          for (const sourceNode of node.producerNode) {
            producerAccessed(sourceNode);
          }
        } finally {
          setActiveConsumer(prev);
        }
      }

      detach(): void {
        const node = this[NODE];
        node.consumerIsLive = false;
        if (!node.producerNode?.length || !node.producerIndexOfThis?.length) return;

        for (let i = 0; i < node.producerNode.length; i++) {
          producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
        }
      }
    }

    export function currentComputed(): Computed<any> | undefined {
      return getActiveConsumer()?.wrapper;
    }

    // Hooks to observe being watched or no longer watched
    export const watched = Symbol('watched');
    export const unwatched = Symbol('unwatched');
  }

  export interface Options<T> {
    // Custom comparison function between old and new value. Default: Object.is.
    // The signal is passed in as an optionally-used third parameter for context.
    equals?: (this: AnySignal<T>, t: T, t2: T) => boolean;

    // Callback called when hasSinks becomes true, if it was previously false
    [Signal.subtle.watched]?: (this: AnySignal<T>) => void;

    // Callback called whenever hasSinks becomes false, if it was previously true
    [Signal.subtle.unwatched]?: (this: AnySignal<T>) => void;
  }
}
