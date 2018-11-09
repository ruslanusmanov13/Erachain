package org.erachain.core.transaction;

import com.google.common.primitives.Longs;
import org.erachain.core.BlockChain;
import org.erachain.core.account.PublicKeyAccount;
import org.erachain.core.item.templates.TemplateCls;
import org.erachain.core.item.templates.TemplateFactory;

import java.math.BigDecimal;
import java.util.Arrays;

//import java.util.Map;
// import org.slf4j.LoggerFactory;
import org.slf4j.Logger;

public class IssueTemplateRecord extends Issue_ItemRecord {
    private static final byte TYPE_ID = (byte) ISSUE_TEMPLATE_TRANSACTION;
    private static final String NAME_ID = "Issue Template";

    public IssueTemplateRecord(byte[] typeBytes, PublicKeyAccount creator, TemplateCls template, byte feePow, long timestamp, Long reference) {
        super(typeBytes, NAME_ID, creator, template, feePow, timestamp, reference);
    }

    public IssueTemplateRecord(byte[] typeBytes, PublicKeyAccount creator, TemplateCls template, byte feePow, long timestamp, Long reference, byte[] signature) {
        super(typeBytes, NAME_ID, creator, template, feePow, timestamp, reference, signature);
    }
    public IssueTemplateRecord(byte[] typeBytes, PublicKeyAccount creator, TemplateCls template, byte feePow,
                               long timestamp, Long reference, byte[] signature, long feeLong) {
        super(typeBytes, NAME_ID, creator, template, feePow, timestamp, reference, signature);
        this.fee = BigDecimal.valueOf(feeLong, BlockChain.AMOUNT_DEDAULT_SCALE);
    }

    public IssueTemplateRecord(byte[] typeBytes, PublicKeyAccount creator, TemplateCls template, byte[] signature) {
        super(typeBytes, NAME_ID, creator, template, (byte) 0, 0l, null, signature);
    }

    public IssueTemplateRecord(PublicKeyAccount creator, TemplateCls template, byte feePow, long timestamp, Long reference, byte[] signature) {
        this(new byte[]{TYPE_ID, 0, 0, 0}, creator, template, feePow, timestamp, reference, signature);
    }

    public IssueTemplateRecord(PublicKeyAccount creator, TemplateCls template, byte[] signature) {
        this(new byte[]{TYPE_ID, 0, 0, 0}, creator, template, (byte) 0, 0l, null, signature);
    }

    public IssueTemplateRecord(PublicKeyAccount creator, TemplateCls template, byte feePow, long timestamp, Long reference) {
        this(new byte[]{TYPE_ID, 0, 0, 0}, creator, template, feePow, timestamp, reference);
    }

    public IssueTemplateRecord(PublicKeyAccount creator, TemplateCls template) {
        this(new byte[]{TYPE_ID, 0, 0, 0}, creator, template, (byte) 0, 0l, null);
    }

    //GETTERS/SETTERS
    //public static String getName() { return "Issue Template"; }

    // RETURN START KEY in tot GEMESIS
    public long getStartKey(int height) {

        if (height < BlockChain.VERS_4_11) {
            return 1000l;
        }

        return START_KEY;

    }

    public static Transaction Parse(byte[] data, int asDeal) throws Exception {

        int test_len;
        if (asDeal == Transaction.FOR_MYPACK) {
            test_len = BASE_LENGTH_AS_MYPACK;
        } else if (asDeal == Transaction.FOR_PACK) {
            test_len = BASE_LENGTH_AS_PACK;
        } else if (asDeal == Transaction.FOR_DB_RECORD) {
            test_len = BASE_LENGTH_AS_DBRECORD;
        } else {
            test_len = BASE_LENGTH;
        }

        if (data.length < test_len) {
            throw new Exception("Data does not match block length " + data.length);
        }

        // READ TYPE
        byte[] typeBytes = Arrays.copyOfRange(data, 0, TYPE_LENGTH);
        int position = TYPE_LENGTH;

        long timestamp = 0;
        if (asDeal > Transaction.FOR_MYPACK) {
            //READ TIMESTAMP
            byte[] timestampBytes = Arrays.copyOfRange(data, position, position + TIMESTAMP_LENGTH);
            timestamp = Longs.fromByteArray(timestampBytes);
            position += TIMESTAMP_LENGTH;
        }

        //READ REFERENCE
        byte[] referenceBytes = Arrays.copyOfRange(data, position, position + REFERENCE_LENGTH);
        Long reference = Longs.fromByteArray(referenceBytes);
        position += REFERENCE_LENGTH;

        //READ CREATOR
        byte[] creatorBytes = Arrays.copyOfRange(data, position, position + CREATOR_LENGTH);
        PublicKeyAccount creator = new PublicKeyAccount(creatorBytes);
        position += CREATOR_LENGTH;

        byte feePow = 0;
        if (asDeal > Transaction.FOR_PACK) {
            //READ FEE POWER
            byte[] feePowBytes = Arrays.copyOfRange(data, position, position + 1);
            feePow = feePowBytes[0];
            position += 1;
        }

        //READ SIGNATURE
        byte[] signatureBytes = Arrays.copyOfRange(data, position, position + SIGNATURE_LENGTH);
        position += SIGNATURE_LENGTH;

        long feeLong = 0;
        if (asDeal == FOR_DB_RECORD) {
            // READ FEE
            byte[] feeBytes = Arrays.copyOfRange(data, position, position + FEE_LENGTH);
            feeLong = Longs.fromByteArray(feeBytes);
            position += FEE_LENGTH;
        }

        //READ PLATE
        // template parse without reference - if is = signature
        TemplateCls template = TemplateFactory.getInstance().parse(Arrays.copyOfRange(data, position, data.length), false);
        position += template.getDataLength(false);

        if (asDeal > Transaction.FOR_MYPACK) {
            return new IssueTemplateRecord(typeBytes, creator, template, feePow, timestamp, reference, signatureBytes, feeLong);
        } else {
            return new IssueTemplateRecord(typeBytes, creator, template, signatureBytes);
        }
    }

    //PARSE CONVERT

    //@Override
    public int isValid(int asDeal, long flags) {

        int result = super.isValid(asDeal, flags);
        if (result != Transaction.VALIDATE_OK) return result;

		/*
		BigDecimal balERA = this.creator.getBalanceUSE(RIGHTS_KEY, db);
		if ( balERA.compareTo(BlockChain.MAJOR_ERA_BALANCE_BD)<0 )
		{
			return Transaction.NOT_ENOUGH_RIGHTS;
		}
		*/

        return Transaction.VALIDATE_OK;
    }

    //VALIDATE


    //PROCESS/ORPHAN


}