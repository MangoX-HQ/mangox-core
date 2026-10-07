import { AsyncLocalStorage } from 'async_hooks';

interface RequestContextData {
  requestId: string;
  method?: string;
  url?: string;
  startTime?: number;
  [key: string]: any;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

export const RequestContext = {
  // Get current request ID from AsyncLocalStorage
  getRequestId(): string | undefined {
    const store = asyncLocalStorage.getStore();
    return store?.requestId;
  },

  // Set current request ID (used internally)
  setCurrentRequestId(requestId: string): void {
    const currentStore = asyncLocalStorage.getStore() || {};
    const newStore = { ...currentStore, requestId };
    asyncLocalStorage.enterWith(newStore);
  },

  // Clear current request ID
  clearCurrentRequestId(): void {
    asyncLocalStorage.enterWith({} as RequestContextData);
  },

  // Run a function with context
  run<T>(requestId: string, fn: () => T): T {
    const contextData: RequestContextData = { requestId };
    return asyncLocalStorage.run(contextData, fn);
  }
};