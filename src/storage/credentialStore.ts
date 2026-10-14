export const CREDENTIAL_SCHEMA_VERSION = 1 as const;

const DATABASE_NAME = 'ptv-webos-protected-credentials';
const DATABASE_VERSION = 1;
const CREDENTIAL_STORE_NAME = 'credentials';
const KEY_STORE_NAME = 'keys';
const SESSION_KEY_ID = 'session-aes-gcm-v1';
const AES_GCM_IV_BYTES = 12;

export interface CredentialBinding {
  schemaVersion: typeof CREDENTIAL_SCHEMA_VERSION;
  credentialId: string;
  serverUrl: string;
  serverId: string;
  userId: string;
  deviceId: string;
}

/**
 * High-level adapter boundary used by the repository. The production adapter
 * encrypts with WebCrypto and persists only ciphertext; tests can inject an
 * in-memory implementation without pretending jsdom has IndexedDB.
 */
export interface ProtectedCredentialStore {
  writeCredential(
    binding: CredentialBinding,
    accessToken: string,
    assertWritable?: () => void
  ): Promise<void>;
  readCredential(binding: CredentialBinding): Promise<string | null>;
  deleteCredential(credentialId: string): Promise<void>;
  hasCredential(credentialId: string): Promise<boolean>;
  clearAllCredentialsAndKey(): Promise<void>;
  hasAnyCredential(): Promise<boolean>;
  hasKey(): Promise<boolean>;
}

export class InvalidProtectedCredentialError extends Error {
  public readonly code = 'INVALID_PROTECTED_CREDENTIAL' as const;

  constructor(message = 'The protected credential is missing or invalid', cause?: unknown) {
    super(message);
    this.name = 'InvalidProtectedCredentialError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

interface StoredCredentialRecord {
  credentialId: string;
  schemaVersion: typeof CREDENTIAL_SCHEMA_VERSION;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

interface StoredKeyRecord {
  id: string;
  key: CryptoKey;
}

let exclusiveStoreOperation: Promise<void> = Promise.resolve();

function runStoreOperationExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = exclusiveStoreOperation.then(operation, operation);
  exclusiveStoreOperation = result.then(() => undefined, () => undefined);
  return result;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function requireWebCrypto(): Crypto {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.getRandomValues !== 'function' ||
    !crypto.subtle
  ) {
    throw new Error('WebCrypto is unavailable');
  }
  return crypto;
}

function requireIndexedDb(): IDBFactory {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable');
  return indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = requireIndexedDb().open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE_NAME)) {
        database.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(CREDENTIAL_STORE_NAME)) {
        database.createObjectStore(CREDENTIAL_STORE_NAME, { keyPath: 'credentialId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open protected credential storage'));
    request.onblocked = () => reject(new Error('Protected credential storage upgrade is blocked'));
  });
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function canonicalAdditionalData(binding: CredentialBinding): ArrayBuffer {
  return arrayBufferFromBytes(new TextEncoder().encode(JSON.stringify([
    binding.schemaVersion,
    binding.credentialId,
    binding.serverUrl,
    binding.serverId,
    binding.userId,
    binding.deviceId
  ])));
}

function normalizeByteArray(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function isUsableAesKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CryptoKey>;
  return (
    candidate.type === 'secret' &&
    candidate.extractable === false &&
    candidate.algorithm?.name === 'AES-GCM' &&
    Array.isArray(candidate.usages) &&
    candidate.usages.includes('encrypt') &&
    candidate.usages.includes('decrypt')
  );
}

export class IndexedDbProtectedCredentialStore implements ProtectedCredentialStore {
  private async readKeyUnlocked(): Promise<CryptoKey | null> {
    return withDatabase(async database => {
      const transaction = database.transaction(KEY_STORE_NAME, 'readonly');
      const record = await requestResult(
        transaction.objectStore(KEY_STORE_NAME).get(SESSION_KEY_ID)
      ) as StoredKeyRecord | undefined;
      await transactionComplete(transaction);
      return isUsableAesKey(record?.key) ? record.key : null;
    });
  }

  private async getOrCreateKeyUnlocked(): Promise<CryptoKey> {
    const existing = await this.readKeyUnlocked();
    if (existing) return existing;

    const generated = await requireWebCrypto().subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    if (!isUsableAesKey(generated)) throw new Error('Unable to create a protected AES key');

    await withDatabase(async database => {
      const transaction = database.transaction(KEY_STORE_NAME, 'readwrite');
      transaction.objectStore(KEY_STORE_NAME).put({ id: SESSION_KEY_ID, key: generated } as StoredKeyRecord);
      await transactionComplete(transaction);
    });

    // Reopen and read the persisted CryptoKey. This catches platforms that
    // expose WebCrypto but cannot structured-clone CryptoKey into IndexedDB.
    const persisted = await this.readKeyUnlocked();
    if (!persisted) throw new Error('Unable to verify the persisted protected AES key');
    return persisted;
  }

  public writeCredential(
    binding: CredentialBinding,
    accessToken: string,
    assertWritable?: () => void
  ): Promise<void> {
    return runStoreOperationExclusive(async () => {
      assertWritable?.();
      const webCrypto = requireWebCrypto();
      const key = await this.getOrCreateKeyUnlocked();
      const iv = webCrypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
      const ciphertext = await webCrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: arrayBufferFromBytes(iv),
          additionalData: canonicalAdditionalData(binding),
          tagLength: 128
        },
        key,
        arrayBufferFromBytes(new TextEncoder().encode(accessToken))
      );

      await withDatabase(async database => {
        const transaction = database.transaction(CREDENTIAL_STORE_NAME, 'readwrite');
        transaction.objectStore(CREDENTIAL_STORE_NAME).put({
          credentialId: binding.credentialId,
          schemaVersion: CREDENTIAL_SCHEMA_VERSION,
          iv: arrayBufferFromBytes(iv),
          ciphertext
        } as StoredCredentialRecord);
        await transactionComplete(transaction);
      });
    });
  }

  public readCredential(binding: CredentialBinding): Promise<string | null> {
    return runStoreOperationExclusive(async () => {
      const record = await withDatabase(async database => {
        const transaction = database.transaction(CREDENTIAL_STORE_NAME, 'readonly');
        const stored = await requestResult(
          transaction.objectStore(CREDENTIAL_STORE_NAME).get(binding.credentialId)
        ) as StoredCredentialRecord | undefined;
        await transactionComplete(transaction);
        return stored ?? null;
      });
      if (!record || record.schemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
        throw new InvalidProtectedCredentialError();
      }
      const iv = normalizeByteArray(record.iv);
      const ciphertext = normalizeByteArray(record.ciphertext);
      if (!iv || iv.byteLength !== AES_GCM_IV_BYTES || !ciphertext) {
        throw new InvalidProtectedCredentialError();
      }

      const key = await this.readKeyUnlocked();
      if (!key) throw new InvalidProtectedCredentialError('The protected AES key is unavailable');
      try {
        const plaintext = await requireWebCrypto().subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: arrayBufferFromBytes(iv),
            additionalData: canonicalAdditionalData(binding),
            tagLength: 128
          },
          key,
          arrayBufferFromBytes(ciphertext)
        );
        return new TextDecoder().decode(plaintext);
      } catch (error) {
        const name = error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: unknown }).name)
          : '';
        if (name === 'OperationError' || name === 'DataError') {
          throw new InvalidProtectedCredentialError('Protected credential integrity verification failed', error);
        }
        throw error;
      }
    });
  }

  public deleteCredential(credentialId: string): Promise<void> {
    return runStoreOperationExclusive(async () => {
      await withDatabase(async database => {
        const transaction = database.transaction(CREDENTIAL_STORE_NAME, 'readwrite');
        transaction.objectStore(CREDENTIAL_STORE_NAME).delete(credentialId);
        await transactionComplete(transaction);
      });
    });
  }

  public hasCredential(credentialId: string): Promise<boolean> {
    return runStoreOperationExclusive(() => withDatabase(async database => {
        const transaction = database.transaction(CREDENTIAL_STORE_NAME, 'readonly');
        const count = await requestResult(
          transaction.objectStore(CREDENTIAL_STORE_NAME).count(credentialId)
        );
        await transactionComplete(transaction);
        return count > 0;
      })
    );
  }

  public clearAllCredentialsAndKey(): Promise<void> {
    return runStoreOperationExclusive(async () => {
      await withDatabase(async database => {
        const transaction = database.transaction(
          [CREDENTIAL_STORE_NAME, KEY_STORE_NAME],
          'readwrite'
        );
        transaction.objectStore(CREDENTIAL_STORE_NAME).clear();
        transaction.objectStore(KEY_STORE_NAME).delete(SESSION_KEY_ID);
        await transactionComplete(transaction);
      });
    });
  }

  public hasAnyCredential(): Promise<boolean> {
    return runStoreOperationExclusive(() => withDatabase(async database => {
      const transaction = database.transaction(CREDENTIAL_STORE_NAME, 'readonly');
      const count = await requestResult(transaction.objectStore(CREDENTIAL_STORE_NAME).count());
      await transactionComplete(transaction);
      return count > 0;
    }));
  }

  public hasKey(): Promise<boolean> {
    return runStoreOperationExclusive(async () => (await this.readKeyUnlocked()) !== null);
  }
}

type CredentialStoreFactory = () => ProtectedCredentialStore;
let credentialStoreFactoryForTests: CredentialStoreFactory | null = null;

export function createProtectedCredentialStore(): ProtectedCredentialStore {
  return credentialStoreFactoryForTests
    ? credentialStoreFactoryForTests()
    : new IndexedDbProtectedCredentialStore();
}

/** Explicit jsdom test hook. Production never falls back to memory storage. */
export function setCredentialStoreFactoryForTests(factory: CredentialStoreFactory | null): void {
  credentialStoreFactoryForTests = factory;
}

/** A deterministic, non-persistent adapter intended only for unit/integration tests. */
export class InMemoryProtectedCredentialStoreForTests implements ProtectedCredentialStore {
  private readonly values = new Map<string, { binding: string; accessToken: string }>();
  private keyPresent = false;

  public async writeCredential(
    binding: CredentialBinding,
    accessToken: string,
    assertWritable?: () => void
  ): Promise<void> {
    assertWritable?.();
    this.keyPresent = true;
    this.values.set(binding.credentialId, {
      binding: JSON.stringify(binding),
      accessToken
    });
  }

  public async readCredential(binding: CredentialBinding): Promise<string | null> {
    const stored = this.values.get(binding.credentialId);
    return stored?.binding === JSON.stringify(binding) ? stored.accessToken : null;
  }

  public async deleteCredential(credentialId: string): Promise<void> {
    this.values.delete(credentialId);
  }

  public async hasCredential(credentialId: string): Promise<boolean> {
    return this.values.has(credentialId);
  }

  public async clearAllCredentialsAndKey(): Promise<void> {
    this.values.clear();
    this.keyPresent = false;
  }

  public async hasAnyCredential(): Promise<boolean> {
    return this.values.size > 0;
  }

  public async hasKey(): Promise<boolean> {
    return this.keyPresent;
  }
}
