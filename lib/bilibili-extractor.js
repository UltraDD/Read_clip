/**
 * Bilibili Video Extractor
 * 提取B站视频的字幕、封面等信息
 * 
 * 注意：此模块设计为在 content script 中运行，
 * 以便利用用户的登录状态获取字幕
 */

const BilibiliExtractor = {
    /**
     * 检测 URL 是否是 B站视频链接
     */
    isBilibiliVideo(url) {
        if (!url) return false;
        return /bilibili\.com\/video\/(BV[\w]+|av\d+)/i.test(url) ||
               /b23\.tv\/[\w]+/i.test(url);
    },

    /**
     * 从 URL 中解析 BV 号或 AV 号
     */
    parseVideoId(url) {
        // BV号
        const bvMatch = url.match(/BV([\w]+)/i);
        if (bvMatch) {
            return { type: 'bvid', id: 'BV' + bvMatch[1] };
        }
        // AV号
        const avMatch = url.match(/av(\d+)/i);
        if (avMatch) {
            return { type: 'aid', id: avMatch[1] };
        }
        return null;
    },

    /**
     * 从页面中提取视频信息 (利用页面已有数据)
     */
    extractFromPage() {
        // 方法1: 从 __INITIAL_STATE__ 获取
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent || '';
            if (text.includes('__INITIAL_STATE__')) {
                const match = text.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
                if (match) {
                    try {
                        const state = JSON.parse(match[1]);
                        if (state.videoData) {
                            return {
                                bvid: state.videoData.bvid,
                                aid: state.videoData.aid,
                                cid: state.videoData.cid,
                                title: state.videoData.title,
                                desc: state.videoData.desc,
                                pic: state.videoData.pic,
                                owner: state.videoData.owner,
                                pubdate: state.videoData.pubdate,
                                duration: state.videoData.duration,
                                subtitle: state.videoData.subtitle // 可能包含字幕信息
                            };
                        }
                    } catch (e) {
                        console.warn('解析 __INITIAL_STATE__ 失败:', e);
                    }
                }
            }
        }

        // 方法2: 从 meta 标签获取基本信息
        const title = document.querySelector('meta[property="og:title"]')?.content ||
                      document.querySelector('h1.video-title')?.textContent ||
                      document.title.replace(/_哔哩哔哩.*/, '');
        const pic = document.querySelector('meta[property="og:image"]')?.content;
        const author = document.querySelector('.up-name')?.textContent?.trim() ||
                       document.querySelector('meta[name="author"]')?.content;

        return { title, pic, owner: { name: author } };
    },

    /**
     * 获取视频基本信息（通过API，带Cookie）
     */
    async getVideoInfo(videoId) {
        const param = videoId.type === 'bvid' ? `bvid=${videoId.id}` : `aid=${videoId.id}`;
        const url = `https://api.bilibili.com/x/web-interface/view?${param}`;
        
        console.log('[B站] 获取视频信息:', url);
        
        const response = await fetch(url, {
            credentials: 'include'
        });
        
        // 检查响应类型
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await response.text();
            console.error('[B站] 视频信息API返回非JSON:', text.substring(0, 200));
            throw new Error('视频信息API返回格式错误');
        }
        
        const data = await response.json();
        if (data.code !== 0) {
            throw new Error(`获取视频信息失败: ${data.message}`);
        }
        
        const info = data.data;
        return {
            bvid: info.bvid,
            aid: info.aid,
            cid: info.cid,
            title: info.title,
            desc: info.desc,
            pic: info.pic,
            owner: {
                mid: info.owner.mid,
                name: info.owner.name,
                face: info.owner.face
            },
            pubdate: info.pubdate,
            duration: info.duration,
            pages: info.pages || [],
            subtitle: info.subtitle
        };
    },

    /**
     * 获取视频字幕列表（通过API，带Cookie）
     * 优先返回 AI 小助手字幕，其次是 AI 生成字幕
     */
    async getSubtitleList(bvid, cid) {
        // 尝试新版 wbi 接口，如果失败则尝试旧版
        const urls = [
            `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`,
            `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`
        ];
        
        let lastError = null;
        
        for (const url of urls) {
            try {
                console.log('[B站] 尝试获取字幕列表:', url);
                
                const response = await fetch(url, {
                    credentials: 'include'
                });
                
                const contentType = response.headers.get('content-type') || '';
                if (!contentType.includes('application/json')) {
                    console.warn('[B站] 字幕API返回非JSON，尝试下一个接口');
                    continue;
                }
                
                const data = await response.json();
                
                if (data.code !== 0) {
                    console.warn(`[B站] API返回错误 code=${data.code}: ${data.message}`);
                    lastError = new Error(data.message);
                    continue;
                }
                
                const subtitles = data.data?.subtitle?.subtitles || [];
                
                console.log('[B站字幕] 获取到字幕列表:', subtitles.length, '条');
                subtitles.forEach((s, i) => {
                    console.log(`  [${i}] ${s.lan_doc || s.lan} - ai_type:${s.ai_type} ai_status:${s.ai_status}`);
                });
                
                // 排序：优先 AI 字幕
                subtitles.sort((a, b) => {
                    const aIsChinese = /中文|zh/i.test(a.lan);
                    const bIsChinese = /中文|zh/i.test(b.lan);
                    if (aIsChinese && !bIsChinese) return -1;
                    if (!aIsChinese && bIsChinese) return 1;
                    return (b.ai_type || 0) - (a.ai_type || 0);
                });
                
                return subtitles;
                
            } catch (e) {
                console.warn('[B站] 请求失败:', e.message);
                lastError = e;
            }
        }
        
        throw lastError || new Error('获取字幕列表失败');
    },

    /**
     * 下载并解析字幕内容
     * 注意：字幕URL已包含auth_key，不需要携带Cookie，且必须不携带以避免CORS问题
     */
    async downloadSubtitle(subtitleUrl) {
        // 补全协议
        if (subtitleUrl.startsWith('//')) {
            subtitleUrl = 'https:' + subtitleUrl;
        }
        
        console.log('[B站] 下载字幕:', subtitleUrl);
        
        // 重要：不要使用 credentials，字幕URL自带auth_key认证
        // 使用 credentials: 'include' 会触发 CORS 错误
        const response = await fetch(subtitleUrl, {
            credentials: 'omit',  // 不发送 Cookie，避免 CORS 问题
            mode: 'cors'
        });
        
        if (!response.ok) {
            throw new Error(`字幕下载失败: HTTP ${response.status}`);
        }
        
        const text = await response.text();
        
        // 尝试解析 JSON
        try {
            const data = JSON.parse(text);
            console.log('[B站字幕] 下载字幕成功，条数:', data.body?.length || 0);
            return data.body || [];
        } catch (e) {
            console.error('[B站] 字幕解析失败，原始内容:', text.substring(0, 200));
            throw new Error('字幕格式解析失败');
        }
    },

    /**
     * 将字幕数组转换为纯文本 (TXT 格式)
     */
    subtitlesToText(subtitles) {
        return subtitles.map(item => item.content).join('\n');
    },

    /**
     * 将字幕数组转换为 SRT 格式
     */
    subtitlesToSRT(subtitles) {
        return subtitles.map((item, index) => {
            const startTime = this.formatSRTTime(item.from);
            const endTime = this.formatSRTTime(item.to);
            return `${index + 1}\n${startTime} --> ${endTime}\n${item.content}\n`;
        }).join('\n');
    },

    /**
     * 格式化时间为 SRT 格式 (HH:MM:SS,mmm)
     */
    formatSRTTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    },

    /**
     * 格式化时长为可读格式
     */
    formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        return `${m}:${String(s).padStart(2, '0')}`;
    },

    /**
     * 尝试从页面 script 标签中提取字幕信息
     */
    extractSubtitleFromPage() {
        try {
            // 方法1: 从 window.__playinfo__ 获取
            if (window.__playinfo__ && window.__playinfo__.data?.subtitle?.subtitles) {
                console.log('[B站] 从 __playinfo__ 获取字幕');
                return window.__playinfo__.data.subtitle.subtitles;
            }

            // 方法2: 从页面脚本中提取
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                
                // 查找 playinfo
                if (text.includes('__playinfo__')) {
                    const match = text.match(/__playinfo__\s*=\s*(\{[\s\S]*?\})\s*[;\n]/);
                    if (match) {
                        const playinfo = JSON.parse(match[1]);
                        if (playinfo.data?.subtitle?.subtitles) {
                            console.log('[B站] 从页面脚本获取字幕');
                            return playinfo.data.subtitle.subtitles;
                        }
                    }
                }

                // 查找 INITIAL_STATE 中的字幕
                if (text.includes('__INITIAL_STATE__')) {
                    const match = text.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
                    if (match) {
                        const state = JSON.parse(match[1]);
                        if (state.videoData?.subtitle?.list) {
                            console.log('[B站] 从 INITIAL_STATE 获取字幕');
                            return state.videoData.subtitle.list;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[B站] 从页面提取字幕失败:', e);
        }
        return null;
    },

    /**
     * 完整提取流程：获取视频信息 + 字幕
     * 设计为在 content script 中调用
     */
    async extract(url) {
        // 1. 解析视频 ID
        const videoId = this.parseVideoId(url);
        if (!videoId) {
            throw new Error('无法解析B站视频链接');
        }

        // 2. 获取视频基本信息
        const videoInfo = await this.getVideoInfo(videoId);

        // 3. 尝试多种方式获取字幕列表
        let subtitleList = [];
        
        // 方式1: 尝试从页面提取
        const pageSubtitles = this.extractSubtitleFromPage();
        if (pageSubtitles && pageSubtitles.length > 0) {
            subtitleList = pageSubtitles;
            console.log('[B站] 使用页面提取的字幕列表');
        } else {
            // 方式2: 通过 API 获取
            try {
                subtitleList = await this.getSubtitleList(videoInfo.bvid, videoInfo.cid);
            } catch (e) {
                console.warn('[B站] API获取字幕失败:', e.message);
            }
        }
        
        let subtitles = [];
        let subtitleText = '';
        let subtitleType = 'none';
        let subtitleLang = '';

        if (subtitleList.length > 0) {
            // 排序：优先中文、AI字幕
            subtitleList.sort((a, b) => {
                const aIsChinese = /中文|zh/i.test(a.lan);
                const bIsChinese = /中文|zh/i.test(b.lan);
                if (aIsChinese && !bIsChinese) return -1;
                if (!aIsChinese && bIsChinese) return 1;
                return (b.ai_type || 0) - (a.ai_type || 0);
            });

            // 4. 下载第一个（优先级最高的）字幕
            const bestSubtitle = subtitleList[0];
            const subtitleUrl = bestSubtitle.subtitle_url || bestSubtitle.subtitleUrl;
            
            if (subtitleUrl) {
                subtitles = await this.downloadSubtitle(subtitleUrl);
                subtitleText = this.subtitlesToText(subtitles);
                subtitleLang = bestSubtitle.lan_doc || bestSubtitle.lan;
                
                // 判断字幕类型
                if (bestSubtitle.ai_type === 1) {
                    subtitleType = 'ai_generated';
                } else {
                    subtitleType = 'manual';
                }
            }
        }

        return {
            videoInfo,
            subtitles,
            subtitleText,
            subtitleSRT: subtitles.length > 0 ? this.subtitlesToSRT(subtitles) : '',
            subtitleType,
            subtitleLang,
            hasSubtitle: subtitles.length > 0
        };
    }
};

// 导出供其他脚本使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BilibiliExtractor;
}

