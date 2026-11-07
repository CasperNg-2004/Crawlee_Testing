import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExcelData } from '../src/excel-export.js';

test('flattens nested restaurant data into readable Excel sheets', () => {
  const data = buildExcelData([{
    placeId: 'ChIJexample',
    name: 'Example Cafe',
    contact: { phone: '012-3456789', website: 'https://example.com' },
    menu: { sections: [{ name: 'Drinks', items: [{
      name: 'Coffee', description: null, priceText: 'RM 8.00', priceValue: 8, currency: 'MYR',
    }] }] },
    menuScrape: { status: 'success', tabExists: true, itemCount: 1 },
    photos: [{
      photoId: 'photo-1', tabs: ['All', 'Menu'], uploadDate: { text: 'Nov 2026' },
      width: 1000, height: 800, fullSizeImageUrl: 'https://example.com/photo.jpg',
    }],
    photoScrape: { status: 'success' },
    reviews: [{ reviewId: 'review-1', rating: 5, text: 'Good', publishedText: 'today', likes: null }],
    reviewScrape: { status: 'success' },
    openingHours: [{ day: 'Monday', hours: '9 am–5 pm' }],
    popularTimes: { days: [{
      day: 'Monday',
      hours: [{ time: '10 am', hour: 10, minute: 0, busynessPercent: 50 }],
      peak: [{ time: '10 am', busynessPercent: 50 }],
      quietest: [{ time: '10 am', busynessPercent: 50 }],
    }], overallPeak: [{ day: 'Monday', time: '10 am', busynessPercent: 50 }], overallQuietest: [] },
    about: { Offerings: [{ name: 'Coffee', available: true }] },
  }]);

  assert.equal(data.places.length, 1);
  assert.equal(data.menu.length, 1);
  assert.equal(data.photos.length, 2);
  assert.equal(data.reviews.length, 1);
  assert.equal(data.openingHours.length, 1);
  assert.equal(data.popularTimes.length, 1);
  assert.equal(data.about.length, 1);
  assert.equal(data.popularTimes[0].overallPeak, 'Yes');
  assert.equal(data.places[0].menuTabExists, 'Yes');
  assert.equal(data.about[0].available, 'Yes');
  assert.equal(data.menu[0].priceValue, 8);
});
