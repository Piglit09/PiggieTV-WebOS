import { describe, expect, it } from 'vitest';
import type { PtvItem } from '../src/types/ptv';
import {
  buildPtvSearchCategorySection,
  getPtvSearchFilterConfig,
  getPtvSearchItemTypeLabel,
  mergePtvSearchResults,
  parsePtvSearchCategoryRoute,
  PTV_SEARCH_FILTERS
} from '../src/screens/search/searchModel';

function item(id: string, name: string, type: PtvItem['type']): PtvItem {
  return { id, name, type };
}

describe('webOS search model', () => {
  it('exposes the same ten first-class search filters as the web app', () => {
    expect(PTV_SEARCH_FILTERS.map(filter => filter.id)).toEqual([
      'all',
      'movies',
      'shows',
      'episodes',
      'music',
      'people',
      'collections',
      'reading',
      'genres',
      'studios'
    ]);
    expect(getPtvSearchFilterConfig('genres').categoryKinds).toEqual(['Genre', 'MusicGenre']);
    expect(getPtvSearchFilterConfig('studios').categoryKinds).toEqual(['Studio']);
    expect(getPtvSearchFilterConfig('all').categoryKinds).toEqual(['Genre', 'MusicGenre', 'Studio']);
  });

  it('preserves media and music genres as distinct navigation types', () => {
    expect(getPtvSearchItemTypeLabel(item('genre-1', 'Drama', 'Genre'))).toBe('Genre');
    expect(getPtvSearchItemTypeLabel(item('genre-1', 'Dream Pop', 'MusicGenre'))).toBe('Music genre');

    const merged = mergePtvSearchResults([[
      item('genre-1', 'Drama', 'Genre'),
      item('genre-1', 'Dream Pop', 'MusicGenre')
    ]], 'dr', 'genres');
    expect(merged.map(result => result.type)).toEqual(['Genre', 'MusicGenre']);
  });

  it('reserves space for genres and studios in an All result page', () => {
    const movies = Array.from({ length: 20 }, (_, index) => item(`movie-${index}`, `Marvel ${index}`, 'Movie'));
    const taxonomy = [
      item('genre-marvel', 'Marvel', 'Genre'),
      item('studio-marvel', 'Marvel Studios', 'Studio')
    ];
    const merged = mergePtvSearchResults([movies, taxonomy], 'Marvel', 'all', 16);

    expect(merged).toHaveLength(16);
    expect(merged).toEqual(expect.arrayContaining(taxonomy));
  });

  it('round-trips encoded category routes and rejects malformed routes', () => {
    const section = buildPtvSearchCategorySection('MusicGenre', 'R&B / Soul');
    expect(parsePtvSearchCategoryRoute('genre/rnb', section)).toEqual({
      id: 'genre/rnb',
      kind: 'MusicGenre',
      name: 'R&B / Soul'
    });
    expect(parsePtvSearchCategoryRoute('', section)).toBeNull();
    expect(parsePtvSearchCategoryRoute('id', 'category:Library:Drama')).toBeNull();
    expect(parsePtvSearchCategoryRoute('id', 'category:Genre:%E0%A4%A')).toBeNull();
  });
});
