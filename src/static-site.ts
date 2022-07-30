#!/usr/bin/env node
import {
  Duration, RemovalPolicy, Stack, StackProps
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StaticSiteProperties extends StackProps {
  domainName: string;
  siteSubDomain: string;
  stackName?: string;
}

/**
 * Static site infrastructure, which deploys site content to an S3 bucket.
 *
 * The site redirects from HTTP to HTTPS, using a CloudFront distribution,
 * Route53 alias record, and ACM certificate.
 */
export class StaticSite extends Construct {
  constructor(parent: Stack, name: string, properties: StaticSiteProperties) {
    super(parent, name);

    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(this, `${parent.stackName}-landing-page-ui-library-cloudfront-OAI`, {
      comment: `Cloudfront Origin Access Identity for ${name}`
    });

    // Content bucket
    const siteBucket = new s3.Bucket(this, `${parent.stackName}-landing-page-ui-library-bucket`, {
      bucketName: `${parent.stackName}-landing-page-ui-library-bucket`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      accessControl: s3.BucketAccessControl.PRIVATE,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED
    });

    // Grant access to cloudfront
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [siteBucket.arnForObjects('*')],
      principals: [new iam.CanonicalUserPrincipal(cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId)]
    }));
    parent.exportValue(siteBucket.bucketName, { name: `-${parent.stackName}-bucket-name` });

    let zone;
    let siteDomain;
    let certificate;
    if (properties.domainName) {
      zone = route53.HostedZone.fromLookup(this, `${parent.stackName}-landing-page-ui-library-zone`, { domainName: properties.domainName });
      siteDomain = `${properties.siteSubDomain}.${properties.domainName}`;
      // TLS certificate
      certificate = new acm.DnsValidatedCertificate(this, `${parent.stackName}-landing-page-ui-library-site-certificate`, {
        domainName: siteDomain,
        hostedZone: zone,
        // Cloudfront only checks this region for certificates.
        region: 'us-east-1'
      });
    }

    const responseHeaderPolicy = new cloudfront.ResponseHeadersPolicy(this, `${parent.stackName}-landing-page-ui-library-security-headers-response-header-policy`, {
      comment: 'Security headers response header policy',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: "default-src 'self'"
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(2 * 365),
          includeSubdomains: true,
          preload: true
        },
        contentTypeOptions: {
          override: true
        },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN
        },
        xssProtection: {
          override: true,
          protection: true,
          modeBlock: true
        },
        frameOptions: {
          override: true,
          frameOption: cloudfront.HeadersFrameOption.DENY
        }
      }
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, `${parent.stackName}-landing-page-ui-library-site-distribution`, {
      certificate,
      defaultRootObject: 'index.html',
      domainNames: siteDomain ? [siteDomain] : [],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      enableIpv6: true,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(0)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(0)
        }
      ],
      defaultBehavior: {
        origin: new S3Origin(siteBucket, { originAccessIdentity: cloudfrontOAI }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeaderPolicy,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED
      }
    });
    parent.exportValue(distribution.distributionId, { name: `-${parent.stackName}-cloudFront-distribution-id` });

    // Route53 alias record for the CloudFront distribution
    if (zone) {
      new route53.ARecord(this, `${parent.stackName}-landing-page-ui-library-site-alias-record`, {
        recordName: siteDomain,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
        zone
      });
      parent.exportValue(`https://${siteDomain}`, { name: `-${parent.stackName}-landing-page-ui-url` });
    } else {
      parent.exportValue(`https://${distribution.distributionDomainName}`, { name: `-${parent.stackName}-landing-page-ui-url` });
    }
  }
}
