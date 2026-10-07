import { IStorageService } from './storage.interface';
import { MinioStorageService } from './minio-storage.service';
import { LocalStorageService } from './local-storage.service';

export type StorageMode = 'minio' | 'local';

let storageInstance: IStorageService | null = null;

export function getStorageMode(): StorageMode {
  return (process.env.STORAGE_MODE as StorageMode) || 'minio';
}

export function getStorageService(): IStorageService {
  if (!storageInstance) {
    const mode = getStorageMode();
    if (mode === 'local') {
      storageInstance = new LocalStorageService();
      console.log('[Storage] Using LOCAL storage');
    } else {
      storageInstance = new MinioStorageService();
      console.log('[Storage] Using MINIO storage');
    }
  }
  return storageInstance;
}
