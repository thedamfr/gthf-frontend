/** Immutable bytes already checked against a guarded public revision's SHA-256. */
export class VerifiedArtifactCache {
  private entries = new Map<string, Uint8Array>();
  private bytes = 0;
  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key); this.entries.set(key, value);
    return value.slice();
  }
  set(key: string, value: Uint8Array): void {
    const maximumBytes = 32 * 1024 * 1024;
    if (value.byteLength > maximumBytes) return;
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.bytes -= previous.byteLength; }
    while ((this.bytes + value.byteLength > maximumBytes || this.entries.size >= 64) && this.entries.size) {
      const [oldKey, oldBytes] = this.entries.entries().next().value!;
      this.entries.delete(oldKey); this.bytes -= oldBytes.byteLength;
    }
    this.entries.set(key, value.slice()); this.bytes += value.byteLength;
  }
}
