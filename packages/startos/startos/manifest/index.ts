import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'ekko-studio',
  title: 'Ekko Studio',
  license: 'BUSL-1.1',
  packageRepo: 'https://github.com/EKKOLearnAI/ekko-studio-startOS',
  upstreamRepo: 'https://github.com/EKKOLearnAI/ekko-studio',
  marketingUrl: 'https://ekkostudio.xyz',
  donationUrl: null,
  description: { short, long },
  volumes: ['main', 'startos'],
  images: {
    studio: {
      source: {
        dockerTag:
          'ekkoye8888/hermes-web-ui:v0.7.36@sha256:06a3c3fc30c850f3f68c9c144afedee9c575ece848e55857e97915fd358c91f4',
      },
      arch: ['x86_64', 'aarch64'],
    },
  },
})
