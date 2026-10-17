import { ImageSourcePropType } from 'react-native';
export const emojiItems = [
  { symbol: '😊', name: 'smiling face', source: require('../assets/emoji/1f60a.png') },
  { symbol: '❤️', name: 'heart', source: require('../assets/emoji/2764.png') },
  { symbol: '👍', name: 'thumbs up', source: require('../assets/emoji/1f44d.png') },
  { symbol: '🎉', name: 'party popper', source: require('../assets/emoji/1f389.png') },
  { symbol: '😂', name: 'laughing face', source: require('../assets/emoji/1f602.png') },
  { symbol: '☕', name: 'coffee', source: require('../assets/emoji/2615.png') },
  { symbol: '🌿', name: 'herb', source: require('../assets/emoji/1f33f.png') },
  { symbol: '✨', name: 'sparkles', source: require('../assets/emoji/2728.png') },
];
export const stickerItems = [
  { id: 'cat-lavender', name: 'Lavender cat', source: require('../assets/stickers/lavender.png') },
  { id: 'cat-mint', name: 'Mint cat', source: require('../assets/stickers/mint.png') },
  { id: 'cat-peach', name: 'Peach cat', source: require('../assets/stickers/peach.png') },
  { id: 'cat-rose', name: 'Rose cat', source: require('../assets/stickers/rose.png') },
  { id: 'cat-sky', name: 'Sky cat', source: require('../assets/stickers/sky.png') },
  { id: 'cat-violet', name: 'Violet cat', source: require('../assets/stickers/violet.png') },
];
export function stickerSource(id: string): ImageSourcePropType | undefined { return stickerItems.find(s => s.id === id)?.source; }
