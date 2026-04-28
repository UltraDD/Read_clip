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

        const ossDate = date; 
        const headers = {
            'x-oss-date': ossDate,
            'Content-Type': contentType,
            ...(extraHeaders || {})
        };

        const canonicalizedOSSHeaders = `x-oss-date:${ossDate}\n`;
        const canonicalizedResource = `/${bucket}/${path}`;

        // StringToSign
        // VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedOSSHeaders + CanonicalizedResource
        // FIXED: Based on error logs, OSS is including the Date value in the signature even when x-oss-date is present.
        // So we must include 'date' here instead of leaving it empty.
        const stringToSign = `${method}\n\n${contentType}\n${date}\n${canonicalizedOSSHeaders}${canonicalizedResource}`;

        const signature = await this.computeSignature(accessKeySecret, stringToSign);
        headers['Authorization'] = `OSS ${accessKeyId}:${signature}`;

        const response = await fetch(url, {
            method: method,
            headers: headers,
            body: file
        });

        if (!response.ok) {
            const text = await response.text();
            // Attach debug info to the error message for easier troubleshooting
            const debugInfo = `\n--- DEBUG INFO ---\nMy StringToSign:\n${JSON.stringify(stringToSign)}\n`;
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
