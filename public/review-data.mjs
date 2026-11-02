/**
 * Review data boundary. A future service can implement this interface without
 * changing the page controller. The prototype repository below is memory only.
 */
const seed = [
  { id: 'demo-104', address: '123 Sample Street', neighborhood: 'Old Northeast', submitted: 'Today · 9:14 AM', status: 'pending', theme: 'Winter garden lights', description: 'Warm white lights trace the garden path, with a wreath on the front gate.', tags: ['Lights', 'Wreath', 'Seasonal'], image: './assets/samples/illustration-haunt.webp' },
  { id: 'demo-103', address: '45 Example Avenue', neighborhood: 'Old Northeast', submitted: 'Yesterday · 4:32 PM', status: 'pending', theme: 'A bright holiday porch', description: 'A few strings of colorful lights and simple greenery around the doorway.', tags: ['Lights', 'Greenery', 'Welcoming'], image: './assets/samples/illustration-treat.webp' },
  { id: 'demo-102', address: '8 Fiction Lane', neighborhood: 'Crescent Lake', submitted: 'Oct 28 · 11:06 AM', status: 'pending', theme: 'Snowflake window display', description: 'Paper snowflakes in the windows and a small illuminated tree on the porch.', tags: ['Snowflakes', 'Window display', 'Lights'], image: './assets/samples/lantern.svg' },
  { id: 'demo-101', address: '77 Placeholder Court', neighborhood: 'Crescent Lake', submitted: 'Oct 27 · 2:18 PM', status: 'pending', theme: 'Neighborhood light trail', description: 'A short path lined with lanterns and handmade winter decorations.', tags: ['Lanterns', 'Handmade', 'Seasonal'], image: './assets/samples/illustration-haunt.webp' },
];

export function createDemoReviewRepository() {
  const records = seed.map(record => ({ ...record, tags: [...record.tags] }));
  return {
    async list() { return records.map(record => ({ ...record, tags: [...record.tags] })); },
    async decide(id, status, reason = '') {
      const record = records.find(item => item.id === id);
      if (!record) throw new Error('Review record not found');
      if (!['approved', 'rejected'].includes(status)) throw new Error('Decision must be approved or rejected');
      if (record.status !== 'pending') throw new Error('Only pending records can receive a demo decision');
      record.status = status;
      record.reason = reason;
      record.decidedAt = new Date().toISOString();
      return { ...record, tags: [...record.tags] };
    },
    async undo(id) {
      const record = records.find(item => item.id === id);
      if (!record) throw new Error('Review record not found');
      if (record.status === 'pending') throw new Error('There is no demo decision to undo');
      record.status = 'pending';
      delete record.reason;
      delete record.decidedAt;
      return { ...record, tags: [...record.tags] };
    },
  };
}
