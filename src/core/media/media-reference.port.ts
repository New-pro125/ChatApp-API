/** Implemented by the messaging module; used for GC and delete guards. */
export interface MediaReferenceReader {
  hasLiveReferences(mediaId: string): Promise<boolean>;
}
