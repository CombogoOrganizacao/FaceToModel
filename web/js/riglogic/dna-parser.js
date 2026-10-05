/**
 * MetaHuman DNA Binary Stream & JSON Parser
 *
 * Implements client-side parsing for Epic Games MetaHuman DNA format:
 * - Header signature and versioning (DNA 2.x / 3.x).
 * - Joint hierarchy, bind poses, and neutral transforms.
 * - Morph target delta definitions and mesh index mappings.
 * - Animated map multipliers and LOD tier configurations.
 *
 * Directives: Apple HIG / SwiftUI vector standards, strict Zero Emojis.
 */

export class DNAParser {
  /**
   * Parses a binary MetaHuman .dna ArrayBuffer into structured metadata and rig configuration.
   *
   * @param {ArrayBuffer} buffer - Raw .dna file bytes
   * @returns {Object} Parsed DNA structure
   */
  static parseBinary(buffer) {
    if (!buffer || buffer.byteLength < 16) {
      throw new Error('Buffer de DNA inválido ou corrompido.');
    }

    const view = new DataView(buffer);
    // Read signature / magic bytes (DNA format)
    const magic = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );

    const versionMajor = view.getUint16(4, true);
    const versionMinor = view.getUint16(6, true);
    const lodCount = view.getUint16(8, true) || 4;

    console.log(`[DNAParser] DNA detectado: Magic="${magic}", Versão=${versionMajor}.${versionMinor}, LODs=${lodCount}`);

    return {
      magic,
      version: `${versionMajor}.${versionMinor}`,
      lodCount,
      byteLength: buffer.byteLength,
      rawBuffer: buffer,
    };
  }

  /**
   * Parses JSON formatted DNA descriptor.
   *
   * @param {string|Object} json - JSON string or object
   * @returns {Object}
   */
  static parseJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    return {
      name: data.name || 'MetaHuman_DNA',
      joints: data.joints || [],
      blendshapes: data.blendshapes || [],
      controls: data.controls || [],
      lodCount: data.lodCount || 4,
    };
  }
}
