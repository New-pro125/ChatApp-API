import { injectable } from 'inversify';

const MENTION_TOKEN = /(?<![\w@\/.])@([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/g;

/**
 * Extracts unique, lowercased usernames from a plain-text message body.
 * The grammar mirrors the `users.username` check constraint; the boundary
 * prevents email addresses and URL paths from producing mentions.
 */
@injectable()
export class MentionParser {
  parse(body: string): string[] {
    const names = new Set<string>();

    for (const match of body.matchAll(MENTION_TOKEN)) {
      const name = match[1];

      if (name !== undefined) {
        names.add(name.toLowerCase());
      }
    }

    return [...names];
  }
}
