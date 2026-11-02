import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenPhotoList, photoListToCsv } from '../src/photo-export.js';

test('exports one reader row per photo and tab', () => {
  const rows = flattenPhotoList([{
    placeId: 'ChIJexample',
    name: 'Example Cafe',
    photos: [{
      photoId: 'photo-1',
      tabs: ['All', 'Food & drink'],
      uploadDate: { text: 'October 2026', year: 2026, month: 10, day: null },
      fullSizeImageUrl: 'https://lh3.googleusercontent.com/p/photo-1=s0',
    }],
  }]);

  assert.deepEqual(rows, [
    {
      placeId: 'ChIJexample',
      shopName: 'Example Cafe',
      photoId: 'photo-1',
      tab: 'All',
      uploadDate: 'October 2026',
      fullSizeImageUrl: 'https://lh3.googleusercontent.com/p/photo-1=s0',
    },
    {
      placeId: 'ChIJexample',
      shopName: 'Example Cafe',
      photoId: 'photo-1',
      tab: 'Food & drink',
      uploadDate: 'October 2026',
      fullSizeImageUrl: 'https://lh3.googleusercontent.com/p/photo-1=s0',
    },
  ]);
  assert.match(photoListToCsv(rows), /"Food & drink","October 2026"/);
});

test('keeps missing source values null instead of guessing', () => {
  assert.deepEqual(flattenPhotoList([{
    placeId: 'ChIJmissing',
    name: 'Missing Metadata Cafe',
    photos: [{ photoId: 'photo-2', tabs: ['Menu'] }],
  }]), [{
    placeId: 'ChIJmissing',
    shopName: 'Missing Metadata Cafe',
    photoId: 'photo-2',
    tab: 'Menu',
    uploadDate: null,
    fullSizeImageUrl: null,
  }]);
});
