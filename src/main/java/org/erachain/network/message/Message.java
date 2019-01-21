package org.erachain.network.message;

import com.google.common.primitives.Bytes;
import com.google.common.primitives.Ints;
import org.erachain.controller.Controller;
import org.erachain.core.crypto.Crypto;
import org.erachain.network.Peer;

import java.util.Arrays;

public abstract class Message {

    public static final byte[] MAINNET_MAGIC = {0x19, 0x66, 0x08, 0x21};

    public static final int MAGIC_LENGTH = 4;

    public static final int TYPE_LENGTH = 4;
    public static final int ID_LENGTH = 4;
    public static final int MESSAGE_LENGTH = 4;
    public static final int CHECKSUM_LENGTH = 4;

    /**
     * Запрос: Получить список пиров с узла
     */
    public static final int GET_PEERS_TYPE = 1;
    /**
     * Ответ: Списое пиров узла
     */
    public static final int PEERS_TYPE = 2;
    /**
     * Запрос: Взять высоту и силу цепочки узла
     */
    public static final int GET_HWEIGHT_TYPE = 3;
    /**
     * Ответ: Высота и Сила цепочки узла
     */
    public static final int HWEIGHT_TYPE = 4;
    /**
     * Запрос: взять подписи блоков начиная с данной. В запросе посылается подпись блока для поиска в цепочке узла
     */
    public static final int GET_SIGNATURES_TYPE = 5;
    /**
     * Ответ: список подписей блоков
     */
    public static final int SIGNATURES_TYPE = 6;
    /**
     * Запрос: взять блок по его подписи. В запросе пересылается подпись блока
     */
    public static final int GET_BLOCK_TYPE = 7;
    /**
     * Ответ: блок победитель
     */
    public static final int WIN_BLOCK_TYPE = 8;
    /**
     * Ответ: Блок
     */
    public static final int BLOCK_TYPE = 9;
    /**
     * Ответ: Транзакция неподтвержденная
     */
    public static final int TRANSACTION_TYPE = 10;
    /**
     * не используется
     */
    public static final int GET_PING_TYPE = 11;
    /**
     * Ответ: версия узла и другая информация
     */
    public static final int VERSION_TYPE = 12;
    /**
     * Ответ: Сетевой Идентификатор узла. Используется для идентификации самого себя
     */
    public static final int FIND_MYSELF_TYPE = 13;
    /**
     * Телеграмма
     */
    public static final int TELEGRAM_TYPE = 14;
    /**
     * Запрос: дать телеграммы по фильтру
     */
    public static final int TELEGRAM_GET_TYPE = 15;
    /**
     * Ответ: список телеграмм
     */
    public static final int TELEGRAM_GET_ANSWER_TYPE = 16;

    private int type;
    private Peer sender;
    private int id;
    private int length;

    public Message(int type) {
        this.type = type;

        this.id = -1;
    }

    public static String viewType(int type) {
        switch (type) {
            case 1:
                return "GET_PEERS_TYPE";
            case 2:
                return "PEERS_TYPE";
            case 3:
                return "GET_HWEIGHT_TYPE";
            case 4:
                return "HWEIGHT_TYPE";
            case 5:
                return "GET_SIGNATURES_TYPE";
            case 6:
                return "SIGNATURES_TYPE";
            case 7:
                return "GET_BLOCK_TYPE";
            case 8:
                return "WIN_BLOCK_TYPE";
            case 9:
                return "BLOCK_TYPE";
            case 10:
                return "TRANSACTION_TYPE";
            case 11:
                return "PING_TYPE";
            case 12:
                return "VERSION_TYPE";
            case 13:
                return "FIND_MYSELF_TYPE";
            case 14:
                return "TELEGRAM_TYPE";
            default:
                return "!!!" + type;
        }
    }

    public String toString() {
        return viewType(this.type) + (this.id < 0?"":"[" + this.id + "]");
    }

    public abstract boolean isRequest();

    public int getId() {
        return id;
    }

    public void setId(int id) {
        this.id = id;
    }

    public boolean hasId() {
        return this.id > 0;
    }

    public int getType() {
        return this.type;
    }

    public String viewType() {
        return viewType(this.type);
    }

    public Peer getSender() {
        return this.sender;
    }

    public void setSender(Peer sender) {
        this.sender = sender;
    }

    public void setLength(int length) {
        this.length = length;
    }

    public int getLength() {
        return this.length;
    }

    public byte[] getHash() {
        return Crypto.getInstance().digest(this.toBytes());
    }

    public byte[] toBytes() {
        byte[] data = new byte[0];

        //WRITE MAGIC
        data = Bytes.concat(data, Controller.getInstance().getMessageMagic());

        //WRITE MESSAGE TYPE
        byte[] typeBytes = Ints.toByteArray(this.type);
        typeBytes = Bytes.ensureCapacity(typeBytes, TYPE_LENGTH, 0);
        data = Bytes.concat(data, typeBytes);

        //WRITE HASID
        if (this.hasId()) {
            byte[] hasIdBytes = new byte[]{1};
            data = Bytes.concat(data, hasIdBytes);

            //WRITE ID
            byte[] idBytes = Ints.toByteArray(this.id);
            idBytes = Bytes.ensureCapacity(idBytes, ID_LENGTH, 0);
            data = Bytes.concat(data, idBytes);
        } else {
            byte[] hasIdBytes = new byte[]{0};
            data = Bytes.concat(data, hasIdBytes);
        }

        //WRITE LENGTH
        byte[] lengthBytes = Ints.toByteArray(this.getDataLength());
        data = Bytes.concat(data, lengthBytes);

        return data;
    }

    protected byte[] generateChecksum(byte[] data) {
        byte[] checksum = Crypto.getInstance().digest(data);
        checksum = Arrays.copyOfRange(checksum, 0, CHECKSUM_LENGTH);
        return checksum;
    }

    public abstract int getDataLength();

}
