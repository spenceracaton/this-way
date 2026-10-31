export function requireSuccess(results) {
  if (!results.length || results.some(result => result !== 'success')) {
    throw new Error(`Required validation did not succeed: ${results.map(result => result || 'missing').join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireSuccess(process.argv.slice(2));
}
