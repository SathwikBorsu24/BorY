class YouTubeService {
  extractVideoId(input) {
    if (!input || typeof input !== 'string') return null;
    const value = input.trim();

    const patterns = [
      /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
      /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  async getVideoInfo(videoId) {
    const thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const fallbackThumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const oembedUrl =
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;

    try {
      const resp = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'BorY/2.0' }
      });
      if (!resp.ok) throw new Error(`YouTube oEmbed returned ${resp.status}`);

      const data = await resp.json();
      return {
        videoId,
        title: data.title || 'YouTube Video',
        channel: data.author_name || 'Unknown Channel',
        channelUrl: data.author_url || '',
        thumbnail,
        thumbnailFallback: fallbackThumb,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        source: 'youtube-captions'
      };
    } catch (err) {
      console.error('YouTube info error:', err.message);
      return {
        videoId,
        title: 'YouTube Video',
        channel: 'Unknown Channel',
        channelUrl: '',
        thumbnail: fallbackThumb,
        thumbnailFallback: fallbackThumb,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        source: 'youtube-captions'
      };
    }
  }
}

module.exports = YouTubeService;
