// Runs before the stylesheet paints so a saved light/system theme doesn't flash dark first.
document.documentElement.dataset.theme = (window.frameup && window.frameup.theme) || 'dark';
