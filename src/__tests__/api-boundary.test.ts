import { describe, expect, it } from 'vitest';
import * as publicApi from '../api/index.ts';

describe('public API boundary', () => {
  it('exports public reads without authenticated or transport internals', () => {
    expect(publicApi.getUserCollectionPage).toBeTypeOf('function');
    expect(publicApi).not.toHaveProperty('fetchHtml');
    expect(publicApi).not.toHaveProperty('getCurrentUserProfile');
    expect(publicApi).not.toHaveProperty('getFeed');
    expect(publicApi).not.toHaveProperty('getCollectionRecords');
    expect(publicApi).not.toHaveProperty('loadAuthenticatedUserCollectionPage');
    expect(publicApi).not.toHaveProperty('resolveCk');
    expect(publicApi).not.toHaveProperty('updateSubjectInterest');
  });
});
