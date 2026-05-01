/**
 * Lightweight Aliyun OSS Uploader for Chrome Extensions
 * Uses Web Crypto API (SubtleCrypto) for signing.
 */
class AliyunOSSUploader {
    constructor(config) {
        this.config = config; // { region, accessKeyId, accessKeySecret, bucket }
    }

    /**
     * Uploads a Blob/File to OSS.
     * @param {Blob|File} file - The file to upload.
     * @param {string} path - The object key (path/filename) in the bucket.
     * @param {Object} [extraHeaders] - Optional extra headers (e.g. Cache-Control).
     * @returns {Promise<string>} - The public URL of the uploaded object.
     */
    async upload(file, path, extraHeaders = {}) {
        let { region, bucket, accessKeyId, accessKeySecret } = this.config;
        
        if (region && !region.startsWith('oss-')) {
            region = `oss-${region}`;
        }

        const host = `${bucket}.${region}.aliyuncs.com`;
        const url = `https://${host}/${path}`;
        const method = 'PUT';
        const date = new Date().toUTCString();
        const contentType = file.type || 'application/octet-stream';

        // 收集所有需要发送的 Header
        const headers = {
            'Date': date, // 显式发送 Date 头部
            'x-oss-date': date,
            'Content-Type': contentType,
            ...(extraHeaders || {})
        };

        // 1. 构建 CanonicalizedOSSHeaders
        const ossHeaders = [];
        for (const [key, value] of Object.entries(headers)) {
            const lowKey = key.toLowerCase();
            if (lowKey.startsWith('x-oss-')) {
                ossHeaders.push(`${lowKey}:${String(value).trim()}`);
            }
        }
        ossHeaders.sort();
        const canonicalizedOSSHeaders = ossHeaders.length > 0 
            ? ossHeaders.join('\n') + '\n' 
            : '';

        // 2. 构建 CanonicalizedResource
        const canonicalizedResource = `/${bucket}/${path}`;

        // 3. 构建 StringToSign
        // 结构：VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedOSSHeaders + CanonicalizedResource
        const stringToSign = [
            method,
            '', // Content-MD5
            contentType,
            date, // 这里直接填入 date，与 headers 中的 Date 保持一致
            canonicalizedOSSHeaders + canonicalizedResource
        ].join('\n');

        const signature = await this.computeSignature(accessKeySecret, stringToSign);
        headers['Authorization'] = `OSS ${accessKeyId}:${signature}`;

        const response = await fetch(url, {
            method: method,
            headers: headers,
            body: file
        });

        if (!response.ok) {
            const text = await response.text();
            // 在错误信息中附带调试信息，方便排查签名不匹配
            const debugInfo = `\n--- DEBUG INFO ---\nStringToSign:\n${stringToSign.replace(/\n/g, '\\n')}\n`;
            throw new Error(`OSS Upload Failed: ${response.status} ${text}${debugInfo}`);
        }

        return url;
    }

    async computeSignature(secret, stringToSign) {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(secret);
        const messageData = encoder.encode(stringToSign);

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-1' },
            false,
            ['sign']
        );

        const signatureBuffer = await crypto.subtle.sign(
            'HMAC',
            cryptoKey,
            messageData
        );

        return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    }
}
