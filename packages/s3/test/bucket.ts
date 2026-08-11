import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * Create the test bucket if it is not there yet.
 *
 * Every suite that talks to a real store calls this for itself. Node runs test
 * FILES in parallel, so a suite that assumed another file had already created
 * the bucket was a race: whichever file reached its first PUT first won, and
 * the loser saw `404 NoSuchBucket`. Creation is idempotent, so paying for it
 * per suite is cheaper than the ordering assumption.
 */
export async function ensureBucket(options: {
  bucket: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  credentials: { accessKeyId: string; secretAccessKey: string }
}): Promise<void> {
  const admin = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: options.credentials,
  })
  try {
    await admin.send(new CreateBucketCommand({ Bucket: options.bucket }))
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error
  } finally {
    admin.destroy()
  }
}
