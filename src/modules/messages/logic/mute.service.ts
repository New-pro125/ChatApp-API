import { inject, injectable } from 'inversify';
import { MutePreset, type MutePresetValue } from '@/modules/messages/logic/entities/mute-preset.js';
import { MuteState } from '@/modules/messages/logic/entities/mute-state.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface MuteSettingResult {
  readonly chatId: string;
  readonly muted: boolean;
  readonly muteExpiresAt: Date | null;
}

/** Applies caller-scoped mute presets after checking chat membership. */
@injectable()
export class MuteService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
  ) {}

  async setMute(
    userId: string,
    chatId: string,
    preset: MutePresetValue | null,
    now: Date = new Date(),
  ): Promise<MuteSettingResult> {
    await this.policy.requireMember(chatId, userId);

    const expiry =
      preset === null ? { mutedAt: null, mutedUntil: null } : MutePreset.resolve(preset, now);
    const member = await this.members.setMute(chatId, userId, expiry.mutedAt, expiry.mutedUntil);
    const state = MuteState.from(member, now);

    return { chatId, muted: state.muted, muteExpiresAt: state.expiresAt };
  }
}
