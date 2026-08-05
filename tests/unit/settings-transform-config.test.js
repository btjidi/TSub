import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_PROFILE_FORM } from '../../src/constants/default-settings.js';

describe('Transform config settings', () => {
    it('defaults transformConfig to empty for built-in templates', () => {
        expect(DEFAULT_SETTINGS.transformConfigMode).toBe('builtin');
        expect(DEFAULT_SETTINGS.ruleLevel).toBe('std');
        expect('clashRuleLevel' in DEFAULT_SETTINGS).toBe(false);
        expect(DEFAULT_SETTINGS.transformConfig).toBe('');
        expect(DEFAULT_PROFILE_FORM.ruleLevel).toBe('');
        expect('clashRuleLevel' in DEFAULT_PROFILE_FORM).toBe(false);
        expect(DEFAULT_PROFILE_FORM.transformConfigMode).toBe('global');
    });
});
